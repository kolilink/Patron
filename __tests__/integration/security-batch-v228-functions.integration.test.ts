// migration_v228, Fix A — function exposure. Real Postgres/PostgREST, LOCAL TEST DB ONLY.
//
// Every assertion checks the EXACT refusal (PostgREST 42501 "permission denied
// for function X" for privilege-layer refusals; P0001 "Accès refusé" for the
// membership guard) and, where a row exists, that it is unchanged — never just
// "an error occurred".
import * as fs from 'fs';
import * as path from 'path';
import { createTestUser, createTestBusiness, addMember, createTestProduct, createInviteCode, adminClient, anonClient } from './helpers';
import { assertLocalDb, q, withPg } from './pg';

beforeAll(() => assertLocalDb());

const denied = (fn: string) => expect.objectContaining({ code: '42501', message: expect.stringContaining(`permission denied for function ${fn}`) });
const REFUSED = expect.objectContaining({ code: 'P0001', message: 'Accès refusé' });

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

// The SELECT statement of a function's body (from its first SELECT to the
// first ';'), whitespace-normalized — to prove v228 changed ONLY the guard.
// (Byte-level equality against the live production body was checked
// separately at deploy time; older repo migrations differ from production only
// in column-alignment spaces.)
function selectBlock(sql: string, fn: string): string {
  const clean = stripComments(sql);
  const defs = [...clean.matchAll(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${fn}\\s*\\(`, 'gi'))];
  const start = defs[defs.length - 1].index!; // latest definition in the file
  const rest = clean.slice(start);
  const sel = rest.search(/\bSELECT\b/);
  const end = rest.indexOf(';', sel);
  return rest.slice(sel, end + 1).replace(/\s+/g, ' ').trim();
}

describe('A2 — get_best_sellers / get_order_cogs: original bodies untouched, guard added in a wrapper', () => {
  it('the original SELECT lives unchanged (whitespace-normalized) in the private *_unchecked function', () => {
    const v228 = read('db/migration_v228.sql');
    expect(selectBlock(v228, 'get_best_sellers_unchecked')).toEqual(selectBlock(read('db/migration_v198.sql'), 'get_best_sellers'));
    expect(selectBlock(v228, 'get_order_cogs_unchecked')).toEqual(selectBlock(read('db/migration_v82.sql'), 'get_order_cogs'));
  });

  it('the *_unchecked functions are service_role-only (no caller can bypass the guard)', async () => {
    const { client } = await createTestUser('u');
    const Z = '00000000-0000-0000-0000-000000000000';
    for (const c of [anonClient(), client]) {
      const a = await c.rpc('get_best_sellers_unchecked', { p_business_id: Z, p_month_start: '2020-01-01' });
      expect(a.error).toEqual(denied('get_best_sellers_unchecked'));
      const b = await c.rpc('get_order_cogs_unchecked', { p_business_id: Z, p_since_date: '2020-01-01' });
      expect(b.error).toEqual(denied('get_order_cogs_unchecked'));
    }
  });

  // REGRESSION (found in production right after the first v228 deploy): an in-place
  // plpgsql rewrite passed every test here and then errored for every member in
  // production, whose so_lines.unit_price is `real` while the migration-replayed
  // schema has bigint (plpgsql RETURN QUERY needs EXACT column types; a LANGUAGE sql
  // body coerces). The wrapper must work on both column types.
  it('keeps working when so_lines.unit_price has production\'s `real` type (schema-drift guard)', async () => {
    const { client: owner, userId } = await createTestUser('owner');
    const biz = await createTestBusiness(owner, 'Drift');
    const productId = await createTestProduct(biz, userId, { sale_price: 250000 });
    const sale = await owner.rpc('submit_sale', {
      p_business_id: biz, p_seller_id: userId,
      p_cart: [{ product_id: productId, product_name: 'P', qty: 2, unit_price: 125000 }],
      p_total_amount: 250000, p_pay_method: 'especes', p_pay_amount: 250000,
    });
    expect(sale.error).toBeNull();
    const result = await withPg(async c => {
      await c.query('BEGIN');
      try {
        await c.query('ALTER TABLE so_lines ALTER COLUMN unit_price TYPE real');
        const typ = (await c.query(`SELECT data_type FROM information_schema.columns WHERE table_name='so_lines' AND column_name='unit_price'`)).rows[0].data_type;
        await c.query('SET LOCAL ROLE authenticated');
        await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
        const bs = await c.query(`SELECT product_id, total_qty, total_revenue FROM get_best_sellers($1, '2020-01-01', 5)`, [biz]);
        const cg = await c.query(`SELECT order_id FROM get_order_cogs($1, '2020-01-01')`, [biz]);
        return { typ, bs: bs.rows, cg: cg.rows.length };
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(result.typ).toBe('real');
    expect(result.bs).toHaveLength(1);
    expect(result.bs[0].product_id).toBe(productId);
    expect(Number(result.bs[0].total_revenue)).toBe(250000);
    // and the rollback restored the column type
    const after = await q(`SELECT data_type FROM information_schema.columns WHERE table_name='so_lines' AND column_name='unit_price'`);
    expect(after[0].data_type).not.toBe('real');
  });

  it('anon is refused at the privilege layer', async () => {
    const { client: owner } = await createTestUser('owner');
    const biz = await createTestBusiness(owner, 'Cible');
    const a = anonClient();
    const r1 = await a.rpc('get_best_sellers', { p_business_id: biz, p_month_start: '2020-01-01' });
    expect(r1.data).toBeNull();
    expect(r1.error).toEqual(denied('get_best_sellers'));
    const r2 = await a.rpc('get_order_cogs', { p_business_id: biz, p_since_date: '2020-01-01' });
    expect(r2.data).toBeNull();
    expect(r2.error).toEqual(denied('get_order_cogs'));
  });

  it('an authenticated NON-member gets exactly "Accès refusé" (no data)', async () => {
    const { client: owner, userId } = await createTestUser('owner');
    const biz = await createTestBusiness(owner, 'Cible');
    await createTestProduct(biz, userId, {});
    const { client: outsider } = await createTestUser('outsider');
    await createTestBusiness(outsider, 'Autre');
    const r1 = await outsider.rpc('get_best_sellers', { p_business_id: biz, p_month_start: '2020-01-01' });
    expect(r1.data).toBeNull();
    expect(r1.error).toEqual(REFUSED);
    const r2 = await outsider.rpc('get_order_cogs', { p_business_id: biz, p_since_date: '2020-01-01' });
    expect(r2.data).toBeNull();
    expect(r2.error).toEqual(REFUSED);
  });

  // Phase 9 (migration_v232): this used to assert that a vendeur ALSO got the
  // business-wide ranking and COGS — i.e. it pinned the leak. A vendeur now sees only
  // their own sales in get_best_sellers and is refused get_order_cogs (cost data).
  it('admin gets the real rows; a vendeur gets only THEIR OWN sales and no COGS', async () => {
    const { client: owner, userId: ownerId } = await createTestUser('owner');
    const biz = await createTestBusiness(owner, 'Commerce');
    const productId = await createTestProduct(biz, ownerId, { sale_price: 250000 });
    const { client: seller, userId: sellerId } = await createTestUser('vendeur');
    await addMember(biz, sellerId, 'vendeur');

    const sale = await owner.rpc('submit_sale', {
      p_business_id: biz,
      p_seller_id: ownerId,
      p_cart: [{ product_id: productId, product_name: 'P', qty: 2, unit_price: 125000 }],
      p_total_amount: 250000,
      p_pay_method: 'especes',
      p_pay_amount: 250000,
    });
    expect(sale.error).toBeNull();

    const bs = await owner.rpc('get_best_sellers', { p_business_id: biz, p_month_start: '2020-01-01' });
    expect(bs.error).toBeNull();
    expect(bs.data).toEqual([expect.objectContaining({ product_id: productId, total_qty: 2 })]);
    const cg = await owner.rpc('get_order_cogs', { p_business_id: biz, p_since_date: '2020-01-01' });
    expect(cg.error).toBeNull();
    expect(Array.isArray(cg.data)).toBe(true);

    // the vendeur made no sale: the admin's sale must be invisible to them
    const vbs = await seller.rpc('get_best_sellers', { p_business_id: biz, p_month_start: '2020-01-01' });
    expect(vbs.error).toBeNull();
    expect(vbs.data).toEqual([]);
    const vcg = await seller.rpc('get_order_cogs', { p_business_id: biz, p_since_date: '2020-01-01' });
    expect(vcg.data).toBeNull();
    expect(vcg.error).toEqual(REFUSED);
  });
});

describe('A1/A3/A4 — service_role-only functions', () => {
  const ARGS: Record<string, any> = {
    get_financial_snapshot: {},
    run_reconciliation: {},
    run_display_checks: { p_run_id: '00000000-0000-0000-0000-000000000000' },
    run_variant_price_checks: { p_run_id: '00000000-0000-0000-0000-000000000000' },
    run_supplier_payment_checks: { p_run_id: '00000000-0000-0000-0000-000000000000' },
    refresh_reconciliation_run: { p_run_id: '00000000-0000-0000-0000-000000000000' },
    get_int_setting: { p_key: 'v228_probe', p_default: 7 },
    get_text_setting: { p_key: 'v228_probe' },
    use_invite_code: { code_id: '00000000-0000-0000-0000-000000000000' },
    create_demo_business: { p_business_id: '00000000-0000-0000-0000-000000000000', p_user_id: '00000000-0000-0000-0000-000000000000' },
  };

  it.each(Object.keys(ARGS))('%s: anon refused (42501), authenticated refused (42501)', async (fn) => {
    const { client: user } = await createTestUser('u');
    for (const c of [anonClient(), user]) {
      const r = await c.rpc(fn, ARGS[fn]);
      expect(r.data).toBeNull();
      expect(r.error).toEqual(denied(fn));
    }
  });

  it('service_role can still call them (the reconciliation edge path)', async () => {
    const admin = adminClient();
    const snap = await admin.rpc('get_financial_snapshot');
    expect(snap.error).toBeNull();
    expect(snap.data).not.toBeNull();
    const i = await admin.rpc('get_int_setting', { p_key: 'v228_probe', p_default: 7 });
    expect(i.error).toBeNull();
    expect(i.data).toBe(7);
    const t = await admin.rpc('get_text_setting', { p_key: 'v228_probe' });
    expect(t.error).toBeNull();
    const run = await admin.rpc('run_reconciliation');
    expect(run.error).toBeNull();
    expect(typeof run.data).toBe('string'); // the run id
  });

  it('use_invite_code cannot be used to burn a real invite code', async () => {
    const { client: owner, userId } = await createTestUser('owner');
    const biz = await createTestBusiness(owner, 'Invitations');
    const codeId = (await createInviteCode(biz, userId, {})) as any;
    const id = typeof codeId === 'string' ? codeId : codeId?.id;
    const before = await q(`SELECT id, uses FROM invite_codes WHERE business_id = $1`, [biz]);
    expect(before).toHaveLength(1);
    const r = await anonClient().rpc('use_invite_code', { code_id: before[0].id });
    expect(r.error).toEqual(denied('use_invite_code'));
    const after = await q(`SELECT id, uses FROM invite_codes WHERE business_id = $1`, [biz]);
    expect(after).toEqual(before); // uses unchanged
    void id;
  });
});

describe('A5 — legacy helpers: anon closed, legitimate authenticated callers intact', () => {
  it.each([
    ['get_founder_id', {}],
    ['has_ai_access', { p_business_id: '00000000-0000-0000-0000-000000000000' }],
    ['resolve_referral_code', { p_code: 'NOPE' }],
    ['is_blocked_between', { a: '00000000-0000-0000-0000-000000000000', b: '00000000-0000-0000-0000-000000000000' }],
    ['calculate_merchant_level', { points: 5 }],
  ])('%s: anon refused (42501)', async (fn, args) => {
    // exact arg names differ per function; look them up so the call reaches the privilege check
    const sig = (await q(`SELECT pg_get_function_arguments(oid) AS a FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`, [fn]))[0].a as string;
    const names = sig.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean);
    const vals = Object.values(args);
    const body: Record<string, any> = {};
    names.forEach((n, i) => { body[n] = vals[i]; });
    const r = await anonClient().rpc(fn, body);
    expect(r.error).toEqual(denied(fn));
  });

  it('authenticated callers keep what the app uses (resolve_referral_code at signup)', async () => {
    const { client } = await createTestUser('signup');
    const r = await client.rpc('resolve_referral_code', { p_code: 'NOPE' });
    expect(r.error).toBeNull();
    expect(r.data).toBeNull(); // unknown code → NULL, not a permission error
  });
});

describe('not regressed: v225 / v226 functions are not touched by v228', () => {
  const V225 = ['edit_withdrawal', 'record_payment', 'void_payment', 'void_purchase_order_receipt', 'attach_transaction_proof',
    'delete_transaction_proof', 'delete_market_post', 'mark_support_read', 'submit_support_rating'];
  const V226 = ['get_reports_snapshot', 'get_period_report'];

  it('v228 does not define, replace, grant or revoke any of the 11 functions', () => {
    const code = stripComments(read('db/migration_v228.sql'));
    for (const fn of [...V225, ...V226]) expect(code).not.toMatch(new RegExp(`\\b${fn}\\b`));
  });

  it('v226 grants are intact: anon still has no EXECUTE on the report functions', async () => {
    const rows = await q(`SELECT proname, has_function_privilege('anon', oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', oid, 'EXECUTE') AS auth
                          FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1)`, [V226]);
    expect(rows).toHaveLength(2);
    for (const r of rows) { expect(r.anon).toBe(false); expect(r.auth).toBe(true); }
  });

  it('v225 guards are intact: the NULL-role guard text is still in every body', async () => {
    const rows = await q(`SELECT proname, prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1)`, [V225]);
    expect(rows).toHaveLength(9);
    for (const r of rows) {
      const ok = /IS NULL OR/i.test(r.prosrc) || /IS DISTINCT FROM auth\.uid\(\)/i.test(r.prosrc);
      expect([r.proname, ok]).toEqual([r.proname, true]);
    }
  });
});
