// migration_v238 — founder KPI rebuild + founder "new user" alert.
// LOCAL TEST DB ONLY (plain-Postgres pg-role harness; net.http_post is the
// bootstrap stub, replaced here by a recorder). Run alone:
//   npx jest --config jest.integration.config.js founder-kpi-rebuild --runInBand
import { as, tryAs, seedUser, seedBusiness, seedMember, user, ANON } from './pgrole';
import { assertLocalDb, becomeFounder, resignFounder, lockFounder, unlockFounder, q } from './pg';

beforeAll(() => assertLocalDb());

let founder: string;
let originalNetDef: string;
let suiteStart: Date;

const phone = () => `+224${Math.floor(600000000 + Math.random() * 99999999)}`;
const setPhone = (id: string, p: string | null) => q(`UPDATE profiles SET phone = $2 WHERE id = $1`, [id, p]);

async function realMerchant(label: string, bizName: string) {
  const id = await seedUser(label);
  await setPhone(id, phone());
  const biz = await seedBusiness(id, bizName);
  return { id, biz };
}

const kpis = async () => (await as(user(founder), c => c.query(`SELECT get_founder_kpis() AS k`))).rows[0].k;

beforeAll(async () => {
  suiteStart = new Date();
  await lockFounder();
  founder = await seedUser('founder');
  await becomeFounder(founder);
  // Record every pg_net call so "fires once" is observable.
  originalNetDef = (await q(`SELECT pg_get_functiondef('net.http_post(text,jsonb,jsonb,jsonb,integer)'::regprocedure) AS d`))[0].d;
  await q(`CREATE TABLE IF NOT EXISTS test_net_calls (id serial, url text, body jsonb, headers jsonb)`);
  await q(`CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}',
    headers jsonb DEFAULT '{}', timeout_milliseconds int DEFAULT 5000) RETURNS bigint LANGUAGE sql AS
    $f$ INSERT INTO test_net_calls (url, body, headers) VALUES (url, body, headers); SELECT 1::bigint $f$`);
});

afterAll(async () => {
  await q(originalNetDef);
  await q(`DROP TABLE IF EXISTS test_net_calls`);
  await resignFounder(founder);
  await unlockFounder();
});

describe('founder access', () => {
  it('only the founder can call the new RPCs; anon and merchants are refused', async () => {
    const m = await seedUser('merchant');
    for (const sql of [
      `SELECT get_founder_kpis()`,
      `SELECT get_founder_vendor_directory()`,
      `SELECT log_founder_outreach('whatsapp', 'x', 'y')`,
    ]) {
      const asMerchant = await tryAs(user(m), sql);
      expect(asMerchant.error?.code).toBe('P0001');
      expect(asMerchant.error?.message).toMatch(/Accès refusé/);
      const asAnon = await tryAs(ANON, sql);
      expect(asAnon.error?.code).toBe('42501');
    }
    // helper + tables are not reachable at all
    expect((await tryAs(user(founder), `SELECT founder_invite_installs_between(NULL, NULL)`)).error?.code).toBe('42501');
    expect((await tryAs(user(founder), `SELECT * FROM founder_outreach_log`)).error?.code).toBe('42501');
    expect((await tryAs(user(founder), `SELECT * FROM founder_new_user_alerts`)).error?.code).toBe('42501');
  });
});

describe('get_founder_kpis — superset + test/demo exclusion in every denominator', () => {
  it('keeps every v209 key and adds the new ones', async () => {
    const k = await kpis();
    expect(Object.keys(k)).toEqual(expect.arrayContaining(['generated_at', 'north_star', 'funnel', 'activation', 'retention', 'referral', 'outreach']));
    expect(Object.keys(k.north_star)).toEqual(expect.arrayContaining(['weekly', 'total_real_businesses', 'excluded_test']));
    expect(Object.keys(k.activation)).toEqual(expect.arrayContaining(['cohort', 'activated', 'ttfv_commerce_median_s', 'ttfv_commerce_n', 'ttfv_under_24h', 'u24_cohort', 'u24_hit', 'u24_prev_cohort', 'u24_prev_hit']));
    expect(Object.keys(k.retention)).toEqual(expect.arrayContaining(['w1_cohort', 'w1_retained', 'w4_cohort', 'w4_retained', 'w1_recent_cohort', 'w1_prev_cohort', 'w4_recent_cohort', 'w4_prev_cohort', 'lost_count']));
    expect(Object.keys(k.referral)).toEqual(expect.arrayContaining(['active_30d', 'sharing_30d', 'invites_created_30d', 'referred_n', 'organic_activated', 'invite_installs_total', 'invite_installs_30d', 'invite_installs_prev_30d']));
    expect(Object.keys(k.funnel)).toEqual(expect.arrayContaining(['installed', 'median_s', 'ttfv_install_median_s', 'devices_all_time']));
  });

  it('a real merchant moves total_real_businesses; test, test-owner and demo (phone-less) businesses do not', async () => {
    const before = await kpis();

    const real = await realMerchant('real', 'Vrai commerce');
    const afterReal = await kpis();
    expect(afterReal.north_star.total_real_businesses).toBe(before.north_star.total_real_businesses + 1);
    expect(afterReal.north_star.excluded_test).toBe(before.north_star.excluded_test);

    // flagged test business
    const t = await realMerchant('test', 'Commerce test');
    await q(`UPDATE businesses SET is_test = true WHERE id = $1`, [t.biz]);
    // test OWNER (business itself not flagged)
    const to = await realMerchant('testowner', 'Boutique de l\'équipe');
    await q(`UPDATE profiles SET is_test = true WHERE id = $1`, [to.id]);
    // demo / abandoned anonymous owner: no verified phone
    const demoOwner = await seedUser('demo');
    await seedBusiness(demoOwner, 'Boutique Démo');

    const after = await kpis();
    expect(after.north_star.total_real_businesses).toBe(afterReal.north_star.total_real_businesses);
    expect(after.north_star.excluded_test).toBe(afterReal.north_star.excluded_test + 3);

    // and the activation / retention cohorts agree
    expect(after.activation.cohort).toBe(afterReal.activation.cohort);
    const dir = await as(user(founder), c => c.query(`SELECT get_founder_vendor_directory() AS d`));
    const names = (dir.rows[0].d as any[]).map(r => r.business_name);
    expect(names).toContain('Vrai commerce');
    expect(names).not.toContain('Commerce test');
    expect(names).not.toContain('Boutique de l\'équipe');
    expect(names).not.toContain('Boutique Démo');
    expect(real.biz).toBeTruthy();
  });

  it('invite installs exclude test and phone-less invitees, and agree with get_founder_invite_installs()', async () => {
    const inviter = await seedUser('inviter');
    const realInvitee = await seedUser('inv-real'); await setPhone(realInvitee, phone());
    const testInvitee = await seedUser('inv-test'); await setPhone(testInvitee, phone());
    await q(`UPDATE profiles SET is_test = true WHERE id = $1`, [testInvitee]);
    const anonInvitee = await seedUser('inv-anon');

    const before = await kpis();
    for (const invitee of [realInvitee, testInvitee, anonInvitee]) {
      await q(`INSERT INTO invite_attributions (invitee_id, inviter_id) VALUES ($1, $2)`, [invitee, inviter]);
    }
    const after = await kpis();
    expect(after.referral.invite_installs_total).toBe(before.referral.invite_installs_total + 1);
    expect(after.referral.invite_installs_30d).toBe(before.referral.invite_installs_30d + 1);
    const legacy = await as(user(founder), c => c.query(`SELECT get_founder_invite_installs() AS n`));
    expect(Number(legacy.rows[0].n)).toBe(after.referral.invite_installs_total);
  });

  it('lost_count equals the activated-then-silent list the directory flags', async () => {
    const m = await realMerchant('lost', 'Commerce perdu');
    await q(`INSERT INTO sale_orders (business_id, seller_id, created_by, status, total_amount, discount_amount, sale_date, paid_at, is_credit, created_at)
             VALUES ($1,$2,$2,'paye',100000,0,CURRENT_DATE - 20, now() - interval '20 days', false, now() - interval '20 days')`, [m.biz, m.id]);
    const k = await kpis();
    const dir = (await as(user(founder), c => c.query(`SELECT get_founder_vendor_directory() AS d`))).rows[0].d as any[];
    expect(dir.find(r => r.business_name === 'Commerce perdu').lost).toBe(true);
    expect(k.retention.lost_count).toBe(dir.filter(r => r.lost).length);
  });
});

describe('outreach log round-trip', () => {
  it('logging a contact moves "cette semaine" by exactly one and stores channel/name/note', async () => {
    const before = (await kpis()).outreach;
    const res = await as(user(founder), c => c.query(`SELECT log_founder_outreach('appel', '  Mariama ', 'Veut un rappel') AS r`), true);
    expect(res.rows[0].r.this_week).toBe(before.this_week + 1);
    const after = (await kpis()).outreach;
    expect(after.this_week).toBe(before.this_week + 1);
    expect(after.total).toBe(before.total + 1);
    const row = (await q(`SELECT channel, contact_name, note, created_by FROM founder_outreach_log WHERE id = $1`, [res.rows[0].r.id]))[0];
    expect(row).toEqual({ channel: 'appel', contact_name: 'Mariama', note: 'Veut un rappel', created_by: founder });
  });

  it('a bad channel is refused; a contact from last week counts as prev_week, not this_week', async () => {
    const bad = await tryAs(user(founder), `SELECT log_founder_outreach('pigeon', NULL, NULL)`);
    expect(bad.error?.code).toBe('P0001');
    const before = (await kpis()).outreach;
    await q(`INSERT INTO founder_outreach_log (channel, contacted_at) VALUES ('sms', now() - interval '7 days')`);
    const after = (await kpis()).outreach;
    expect(after.this_week).toBe(before.this_week);
    expect(after.prev_week + after.this_week).toBeGreaterThanOrEqual(before.prev_week + 1);
  });
});

describe('founder "new user" alert (trigger on businesses)', () => {
  const callsFor = (biz: string) => q(`SELECT * FROM test_net_calls WHERE body->>'business_id' = $1`, [biz]);

  it('a new real business queues exactly one founder push with the right title/body/route and one dispatch call', async () => {
    const m = await realMerchant('newbiz', 'Chez Awa');
    const alerts = await q(`SELECT * FROM founder_new_user_alerts WHERE business_id = $1`, [m.biz]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      recipient_user_id: founder,
      title: 'New user',
      body: "Chez Awa vient d'arriver sur Patron.",
      route: '/(app)/founder-kpi/vendeurs',
    });
    const calls = await callsFor(m.biz);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/functions\/v1\/dispatch-notification$/);
    expect(calls[0].body).toEqual({ business_id: m.biz, event_type: 'founder_new_user', payload: {} });
    expect(Object.keys(calls[0].headers)).toContain('x-cron-secret');
  });

  it('never fires twice for the same business (rename, new member, direct re-insert of the alert)', async () => {
    const m = await realMerchant('once', 'Boutique Une Fois');
    const vendeur = await seedUser('vend');
    await seedMember(m.biz, vendeur, 'vendeur');
    await q(`UPDATE businesses SET name = 'Autre nom' WHERE id = $1`, [m.biz]);
    await expect(q(`INSERT INTO founder_new_user_alerts (business_id, recipient_user_id, title, body, route) VALUES ($1,$2,'x','x','x')`, [m.biz, founder]))
      .rejects.toMatchObject({ code: '23505' });
    expect(await q(`SELECT 1 FROM founder_new_user_alerts WHERE business_id = $1`, [m.biz])).toHaveLength(1);
    expect(await callsFor(m.biz)).toHaveLength(1);
  });

  it('targets the founder only — no vendor, manager or owner is ever a recipient', async () => {
    const m = await realMerchant('owner', 'Commerce Cible');
    const vendeur = await seedUser('vendeur2'); const manager = await seedUser('manager2');
    await seedMember(m.biz, vendeur, 'vendeur'); await seedMember(m.biz, manager, 'manager');
    await q(`INSERT INTO device_tokens (user_id, token, platform) VALUES ($1,'ExponentPushToken[vendeur]','ios'), ($2,'ExponentPushToken[owner]','android'), ($3,'ExponentPushToken[founder]','ios')`, [vendeur, m.id, founder]);
    // The devices a push for THIS business would reach = tokens of its alert's recipient.
    const tokens = await q(`SELECT d.token FROM device_tokens d JOIN founder_new_user_alerts a ON a.recipient_user_id = d.user_id WHERE a.business_id = $1`, [m.biz]);
    expect(tokens.map(t => t.token)).toEqual(['ExponentPushToken[founder]']);
    const recipients = await q(`SELECT DISTINCT recipient_user_id FROM founder_new_user_alerts WHERE created_at >= $1`, [suiteStart]);
    expect(recipients.every(r => r.recipient_user_id === founder)).toBe(true);
    expect(await q(`SELECT 1 FROM founder_new_user_alerts WHERE recipient_user_id IN ($1,$2,$3)`, [vendeur, manager, m.id])).toHaveLength(0);
  });

  it('stays silent for test businesses (founder-owned, flagged owner) and demo/anonymous owners', async () => {
    // the founder's own business is test by construction (inherit trigger)
    const fb = await seedBusiness(founder, 'Commerce du fondateur');
    expect(await q(`SELECT 1 FROM founder_new_user_alerts WHERE business_id = $1`, [fb])).toHaveLength(0);
    expect(await callsFor(fb)).toHaveLength(0);

    const teamOwner = await seedUser('team'); await setPhone(teamOwner, phone());
    await q(`UPDATE profiles SET is_test = true WHERE id = $1`, [teamOwner]);
    const tb = await seedBusiness(teamOwner, 'Boutique équipe');
    expect(await q(`SELECT 1 FROM founder_new_user_alerts WHERE business_id = $1`, [tb])).toHaveLength(0);

    const demoOwner = await seedUser('demo2');
    const db = await seedBusiness(demoOwner, 'Boutique Démo');
    expect(await q(`SELECT 1 FROM founder_new_user_alerts WHERE business_id = $1`, [db])).toHaveLength(0);
    expect(await callsFor(db)).toHaveLength(0);
  });

  it('a failing pg_net can never block business creation, and the alert row survives', async () => {
    await q(`CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}',
      headers jsonb DEFAULT '{}', timeout_milliseconds int DEFAULT 5000) RETURNS bigint LANGUAGE plpgsql AS
      $f$ BEGIN RAISE EXCEPTION 'pg_net down'; END $f$`);
    try {
      const m = await realMerchant('netdown', 'Commerce Réseau');
      expect(await q(`SELECT 1 FROM businesses WHERE id = $1`, [m.biz])).toHaveLength(1);
      expect(await q(`SELECT 1 FROM founder_new_user_alerts WHERE business_id = $1`, [m.biz])).toHaveLength(1);
    } finally {
      await q(`CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}',
        headers jsonb DEFAULT '{}', timeout_milliseconds int DEFAULT 5000) RETURNS bigint LANGUAGE sql AS
        $f$ INSERT INTO test_net_calls (url, body, headers) VALUES (url, body, headers); SELECT 1::bigint $f$`);
    }
  });

  it('deleting a business removes its alert (no orphan, no FK block)', async () => {
    const m = await realMerchant('del', 'Commerce Supprimé');
    await q(`DELETE FROM businesses WHERE id = $1`, [m.biz]);
    expect(await q(`SELECT 1 FROM founder_new_user_alerts WHERE business_id = $1`, [m.biz])).toHaveLength(0);
  });
});
