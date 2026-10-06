// migration_v239 — the leave matrix, whole-business delete, and account deletion.
// LOCAL TEST DB ONLY (assertLocalDb). Every RPC runs as a real authenticated
// session (SET LOCAL ROLE authenticated + JWT claims), i.e. the context
// PostgREST gives it; memberships are changed through the same RLS path the app uses.
import { randomUUID } from 'crypto';
import type { Client } from 'pg';
import { assertLocalDb, q, withPg } from './pg';
import { fillBusinessTree } from './helpers/fillBusinessTree';

beforeAll(() => assertLocalDb());

const BUMP_TRIGGERS: Array<[string, string]> = [
  ['sale_orders', 'trg_bump_version_sale_orders'], ['so_lines', 'trg_bump_version_so_lines'],
  ['payments', 'trg_bump_version_payments'], ['stock_moves', 'trg_bump_version_stock_moves'],
  ['products', 'trg_bump_version_products'], ['product_variants', 'trg_bump_version_product_variants'],
  ['clients', 'trg_bump_version_clients'], ['businesses', 'trg_bump_version_businesses'],
  ['suppliers', 'suppliers_guard_delete'],
];

async function makeUser(label: string, phone?: string): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO auth.users (id, aud, role, email) VALUES ($1,'authenticated','authenticated',$2)`,
    [id, `${label}-${id.slice(0, 8)}@test.local`]);
  if (phone) await q(`UPDATE profiles SET phone = $2 WHERE id = $1`, [id, phone]);
  return id;
}

async function asUser<T>(userId: string | null, fn: (c: Client) => Promise<T>): Promise<T> {
  return withPg(async c => {
    await c.query('BEGIN');
    try {
      await c.query('SET LOCAL ROLE authenticated');
      if (userId) await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) { await c.query('ROLLBACK'); throw e; }
  });
}

/** Create a business owned by `ownerId` (the on_business_created trigger adds the admin membership). */
async function makeBusiness(ownerId: string, name: string): Promise<string> {
  const id = randomUUID();
  await withPg(async c => {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: ownerId, role: 'authenticated' })]);
    await c.query(`INSERT INTO businesses (id, name, type, currency, created_by) VALUES ($1,$2,'commerce','GNF',$3)`, [id, name, ownerId]);
    await c.query('COMMIT');
  });
  return id;
}

async function addMember(businessId: string, userId: string, role: string): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO memberships (id, business_id, user_id, role) VALUES ($1,$2,$3,$4)`, [id, businessId, userId, role]);
  return id;
}

const leave = (userId: string | null, businessId: string) =>
  asUser(userId, c => c.query(`SELECT leave_or_delete_business($1)`, [businessId]));

const exists = async (t: string, col: string, id: string) =>
  (await q(`SELECT 1 FROM ${t} WHERE ${col} = $1`, [id])).length > 0;

const triggersEnabled = async () => {
  const rows = await q(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = ANY($1::text[])`, [BUMP_TRIGGERS.map(t => t[1])]);
  return { count: rows.length, allOn: rows.every(r => r.tgenabled === 'O') };
};

describe('whole-business delete (sole admin) — a row in EVERY table of the cascade tree', () => {
  it('fills every table in the tree, deletes cleanly, leaves zero rows anywhere, triggers back on', async () => {
    const owner = await makeUser('owner');
    const biz = await makeBusiness(owner, 'Tout le commerce');
    const report = await withPg(async c => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: owner, role: 'authenticated' })]);
      const r = await fillBusinessTree(c, { businessId: biz, ownerId: owner });
      await c.query('COMMIT');
      return r;
    });

    // Coverage guard: every table in the 45-table tree got a row. A table a future
    // migration adds that this can't fill fails HERE, not silently in production.
    expect(report.failed).toEqual([]);
    expect(Object.keys(report.rows).length).toBe(report.tables.length + 1);
    expect(report.tables.length).toBeGreaterThanOrEqual(44);

    await leave(owner, biz); // must not throw 23503 / P0001

    expect(await exists('businesses', 'id', biz)).toBe(false);
    for (const [t, pkValue] of Object.entries(report.rows)) {
      if (t === 'businesses') continue;
      const pk = (await q(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=$1::regclass AND i.indisprimary`, ['public.' + t]))[0]?.attname ?? 'id';
      expect({ table: t, left: await exists(t, `"${pk}"`, String(pkValue)) }).toEqual({ table: t, left: false });
    }
    // and nothing anywhere still carries the business id
    const withBizCol = await q(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='business_id'`);
    for (const { table_name } of withBizCol) {
      expect({ table: table_name, rows: (await q(`SELECT count(*)::int AS n FROM "${table_name}" WHERE business_id = $1`, [biz]))[0].n })
        .toEqual({ table: table_name, rows: 0 });
    }
    expect(await triggersEnabled()).toEqual({ count: 9, allOn: true });
  });

  it('a failure part-way re-enables the muted triggers and leaves the business intact', async () => {
    const owner = await makeUser('owner-fail');
    const biz = await makeBusiness(owner, 'Commerce qui résiste');
    // a stranger table with a NO ACTION reference to businesses blocks the final DELETE
    await q(`CREATE TABLE IF NOT EXISTS zz_blocker (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), b uuid REFERENCES businesses(id))`);
    await q(`INSERT INTO zz_blocker (b) VALUES ($1)`, [biz]);
    try {
      await expect(leave(owner, biz)).rejects.toMatchObject({ code: '23503' });
      expect(await exists('businesses', 'id', biz)).toBe(true);
      expect(await triggersEnabled()).toEqual({ count: 9, allOn: true });
    } finally {
      await q(`DROP TABLE zz_blocker`);
    }
  });
});

describe('the leave matrix', () => {
  it('non-admin (vendeur, manager) → only their membership goes; the business stays', async () => {
    const owner = await makeUser('o'); const vend = await makeUser('v'); const mgr = await makeUser('m');
    const biz = await makeBusiness(owner, 'Commerce A');
    await addMember(biz, vend, 'vendeur'); await addMember(biz, mgr, 'manager');
    await leave(vend, biz); await leave(mgr, biz);
    expect(await q(`SELECT user_id FROM memberships WHERE business_id=$1 ORDER BY user_id`, [biz])).toEqual([{ user_id: owner }]);
    expect(await exists('businesses', 'id', biz)).toBe(true);
  });

  it('admin + team + ANOTHER admin → leaves; the business and the other admin stay', async () => {
    const a = await makeUser('a'); const b = await makeUser('b'); const v = await makeUser('v');
    const biz = await makeBusiness(a, 'Commerce B');
    await addMember(biz, b, 'administrateur'); await addMember(biz, v, 'vendeur');
    await leave(a, biz);
    const left = (await q(`SELECT user_id FROM memberships WHERE business_id=$1`, [biz])).map(r => r.user_id).sort();
    expect(left).toEqual([b, v].sort());
    expect(await exists('businesses', 'id', biz)).toBe(true);
  });

  it('LAST admin + others → refused with the exact succession sentence, nothing changes', async () => {
    const a = await makeUser('a'); const v = await makeUser('v');
    const biz = await makeBusiness(a, 'Chez Awa');
    await addMember(biz, v, 'vendeur');
    await expect(leave(a, biz)).rejects.toMatchObject({
      code: 'P0001',
      message: 'Vous êtes le seul gérant de Chez Awa. Désignez un successeur avant de quitter.',
    });
    expect((await q(`SELECT 1 FROM memberships WHERE business_id=$1`, [biz])).length).toBe(2);
    expect(await exists('businesses', 'id', biz)).toBe(true);
  });

  it('promote-then-leave is legal under v212 (the guard only blocks DEMOTING the last admin)', async () => {
    const a = await makeUser('a'); const b = await makeUser('b');
    const biz = await makeBusiness(a, 'Commerce C');
    const bMembership = await addMember(biz, b, 'vendeur');

    // the app's own path: an UPDATE on memberships through RLS as the admin
    await asUser(a, c => c.query(`UPDATE memberships SET role='administrateur' WHERE id=$1`, [bMembership]));
    expect((await q(`SELECT role FROM memberships WHERE id=$1`, [bMembership]))[0].role).toBe('administrateur');

    await leave(a, biz);
    expect(await q(`SELECT user_id, role FROM memberships WHERE business_id=$1`, [biz])).toEqual([{ user_id: b, role: 'administrateur' }]);
    expect(await exists('businesses', 'id', biz)).toBe(true);
  });

  it('v212 itself is unchanged: the last admin still cannot demote themselves', async () => {
    const a = await makeUser('a'); const v = await makeUser('v');
    const biz = await makeBusiness(a, 'Commerce D');
    await addMember(biz, v, 'vendeur');
    const aMembership = (await q(`SELECT id FROM memberships WHERE business_id=$1 AND user_id=$2`, [biz, a]))[0].id;
    await expect(asUser(a, c => c.query(`UPDATE memberships SET role='vendeur' WHERE id=$1`, [aMembership])))
      .rejects.toMatchObject({ code: 'P0001', message: 'Impossible de rétrograder le dernier administrateur' });
  });

  it('invalid session / non-member raise exactly as before', async () => {
    const a = await makeUser('a'); const stranger = await makeUser('s');
    const biz = await makeBusiness(a, 'Commerce E');
    await expect(leave(null, biz)).rejects.toMatchObject({ message: 'Session invalide. Reconnectez-vous.' });
    await expect(leave(stranger, biz)).rejects.toMatchObject({ message: "Vous n'êtes pas membre de ce commerce." });
  });
});

describe('delete_my_account — only a SOLE admin with a team is blocked', () => {
  const request = (u: string) => asUser(u, c => c.query(`SELECT delete_my_account()`));
  const pending = async (u: string) => (await q(`SELECT pending_deletion_at FROM profiles WHERE id=$1`, [u]))[0].pending_deletion_at;

  it('sole admin with members → succession sentence naming the business; nothing scheduled', async () => {
    const a = await makeUser('a'); const v = await makeUser('v');
    const biz = await makeBusiness(a, 'Boutique Soleil');
    await addMember(biz, v, 'vendeur');
    await expect(request(a)).rejects.toMatchObject({
      code: 'P0001',
      message: 'Vous êtes le seul gérant de : Boutique Soleil. Désignez un successeur avant de supprimer votre compte.',
    });
    expect(await pending(a)).toBeNull();
  });

  it('admin with a co-admin, a solo owner, and a plain member may all schedule', async () => {
    const co = await makeUser('co'); const co2 = await makeUser('co2');
    const shared = await makeBusiness(co, 'Partagé'); await addMember(shared, co2, 'administrateur');
    const solo = await makeUser('solo'); await makeBusiness(solo, 'Seul');
    const member = await makeUser('member'); await addMember(shared, member, 'vendeur');
    for (const u of [co, solo, member]) {
      await request(u);
      expect(await pending(u)).not.toBeNull();
    }
  });
});

describe('finalize_account_deletion — what the day-30 job actually does', () => {
  const finalize = (u: string) => q(`SELECT finalize_account_deletion($1)`, [u]);
  const due = (u: string) => q(`UPDATE profiles SET pending_deletion_at = now() - interval '1 day' WHERE id=$1`, [u]);

  it('purges a solely-owned business WITH real activity, removes the login and push tokens', async () => {
    const u = await makeUser('leaver');
    const biz = await makeBusiness(u, 'Mon commerce');
    const report = await withPg(async c => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: u, role: 'authenticated' })]);
      const r = await fillBusinessTree(c, { businessId: biz, ownerId: u });
      await c.query('COMMIT');
      return r;
    });
    expect(report.failed).toEqual([]);
    await q(`INSERT INTO device_tokens (user_id, token, platform) VALUES ($1,'ExponentPushToken[leaver]','ios')`, [u]);
    await due(u);

    await finalize(u);

    expect(await exists('businesses', 'id', biz)).toBe(false);
    expect(await exists('device_tokens', 'user_id', u)).toBe(false);
    expect(await exists('profiles', 'id', u)).toBe(false);
    expect(await exists('auth.users', 'id', u)).toBe(false);
    expect(await triggersEnabled()).toEqual({ count: 9, allOn: true });
  });

  it('a member of someone else\'s business keeps that business intact; their authored sale survives, their identity is scrubbed', async () => {
    const owner = await makeUser('boss'); const seller = await makeUser('seller', '+22461' + String(Math.floor(1000000 + Math.random() * 8999999)));
    const biz = await makeBusiness(owner, 'Commerce du patron');
    await addMember(biz, seller, 'vendeur');
    const product = randomUUID(); const sale = randomUUID();
    await q(`INSERT INTO products (id, business_id, name, sale_price, cost_price, stock_qty, created_by) VALUES ($1,$2,'Riz',1000,500,10,$3)`, [product, biz, owner]);
    await q(`INSERT INTO sale_orders (id, business_id, seller_id, created_by, status, total_amount, discount_amount, sale_date) VALUES ($1,$2,$3,$3,'paye',1000,0,CURRENT_DATE)`, [sale, biz, seller]);
    await q(`INSERT INTO device_tokens (user_id, token, platform) VALUES ($1,'ExponentPushToken[seller]','android')`, [seller]);
    await due(seller);

    await finalize(seller);

    expect(await exists('businesses', 'id', biz)).toBe(true);                    // the patron's business is untouched
    expect(await exists('sale_orders', 'id', sale)).toBe(true);                  // the ledger keeps the sale
    expect(await exists('memberships', 'user_id', seller)).toBe(false);
    expect(await exists('device_tokens', 'user_id', seller)).toBe(false);
    const p = (await q(`SELECT name, phone, pending_deletion_at, anonymized_at FROM profiles WHERE id=$1`, [seller]))[0];
    expect(p).toMatchObject({ name: 'Compte supprimé', phone: null, pending_deletion_at: null });
    expect(p.anonymized_at).not.toBeNull();
    const au = (await q(`SELECT email, phone, banned_until FROM auth.users WHERE id=$1`, [seller]))[0];
    expect(au.email).toBeNull(); expect(au.phone).toBeNull(); expect(au.banned_until).not.toBeNull();
  });

  it('a co-admin leaves their shared business standing and is removed', async () => {
    const a = await makeUser('a'); const b = await makeUser('b');
    const biz = await makeBusiness(a, 'Deux gérants'); await addMember(biz, b, 'administrateur');
    await due(a);
    await finalize(a);
    expect(await exists('businesses', 'id', biz)).toBe(true);
    expect(await q(`SELECT user_id FROM memberships WHERE business_id=$1`, [biz])).toEqual([{ user_id: b }]);
  });

  it('a request that became a sole-admin-with-a-team is cleared, not executed', async () => {
    const a = await makeUser('a'); const v = await makeUser('v');
    const biz = await makeBusiness(a, 'Équipe arrivée');
    await due(a);
    await addMember(biz, v, 'vendeur'); // a team appeared after scheduling
    await finalize(a);
    expect(await exists('businesses', 'id', biz)).toBe(true);
    expect(await exists('profiles', 'id', a)).toBe(true);
    expect((await q(`SELECT pending_deletion_at FROM profiles WHERE id=$1`, [a]))[0].pending_deletion_at).toBeNull();
  });

  it('is a no-op when not yet due', async () => {
    const a = await makeUser('a'); await makeBusiness(a, 'Pas encore');
    await q(`UPDATE profiles SET pending_deletion_at = now() + interval '5 days' WHERE id=$1`, [a]);
    await finalize(a);
    expect(await exists('profiles', 'id', a)).toBe(true);
  });
});
