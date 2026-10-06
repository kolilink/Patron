// Founder measurement layer (migration_v209), against a real local Postgres.
//
// Three things are proven here, not assumed:
//   1. ACCESS — only the founder's account (+1 267-242-1843, the same number
//      already hardcoded in src/utils/founder.ts and is_founder()) can read
//      the KPI/call-list RPCs. A vendeur, an administrateur of another shop,
//      and an unauthenticated client are all refused, and nobody — founder
//      included — can SELECT the underlying views/table directly.
//   2. INTEGRITY — is_test traffic (a business flagged test, a business the
//      founder creates, a test device) moves NONE of the founder's numbers,
//      while the same activity on a real business does move them.
//   3. INVITES — an expired consumer invite is now marked 'expired' instead
//      of deleted, and stays hidden from the merchant's own list.
//
// Run alone so other suites' concurrent writes can't touch the snapshots:
//   npx jest --config jest.integration.config.js founder-kpis --runInBand
import { randomUUID } from 'crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { adminClient, createTestUser, createTestBusiness, addMember, createTestProduct } from './helpers';
import { lockFounder, unlockFounder } from './pg';

const FOUNDER_PHONE = '+12672421843';
const LOCAL_URL = process.env.TEST_SUPABASE_URL || 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY
  || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

const admin = adminClient();

function anonClient(): SupabaseClient {
  return createClient(LOCAL_URL, LOCAL_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

function randomGuineaPhone(): string {
  return `+224${Math.floor(600000000 + Math.random() * 99999999)}`;
}

async function setPhone(userId: string, phone: string): Promise<void> {
  const { error } = await admin.from('profiles').update({ phone }).eq('id', userId);
  if (error) throw error;
}

/** A real merchant: phone-verified owner + their own business. */
async function createRealMerchant(name: string) {
  const user = await createTestUser('real');
  await setPhone(user.userId, randomGuineaPhone());
  const businessId = await createTestBusiness(user.client, name);
  return { ...user, businessId };
}

async function insertSale(businessId: string, sellerId: string, status: 'paye' | 'credit' = 'paye'): Promise<void> {
  const { error } = await admin.from('sale_orders').insert({
    business_id: businessId,
    seller_id: sellerId,
    created_by: sellerId,
    status,
    is_credit: status === 'credit',
    total_amount: 500000,
  });
  if (error) throw error;
}

/** The founder's numbers, minus the timestamp that always changes. */
async function snapshot(founder: SupabaseClient) {
  const { data, error } = await founder.rpc('get_founder_kpis');
  if (error) throw error;
  const { generated_at: _ignored, ...rest } = data as Record<string, any>;
  // v238's excluded_test counts the test/demo businesses the denominators leave out, so it
  // MOVES when test businesses are added — by design. Pull it out of the "nothing moves"
  // comparison and assert it separately.
  const { excluded_test: excludedTest, ...northStar } = rest.north_star ?? {};
  rest.north_star = northStar;
  const { data: lists, error: listErr } = await founder.rpc('get_founder_call_lists');
  if (listErr) throw listErr;
  return { kpis: rest, lists, excludedTest: excludedTest as number | undefined };
}

let founder: { client: SupabaseClient; userId: string };

// Suite-level (not per-test): the founder is crowned ONCE in the beforeAll below and
// every test relies on it staying crowned. becomeFounder() in other suites (v230,
// v228-rls, v228-storage) moves the same phone, so without this mutex they steal it
// mid-suite -> "founder can read every KPI RPC" fails with "Accès refusé". This
// beforeAll is declared FIRST so it runs before the crowning one. The advisory lock is
// database-level, so it serializes against the pg.ts-based suites even though this
// one talks through PostgREST helpers.
beforeAll(lockFounder);
afterAll(unlockFounder);

beforeAll(async () => {
  // profiles.phone is unique — free the founder number from any earlier run
  // (local test database only).
  await admin.from('profiles').update({ phone: null }).eq('phone', FOUNDER_PHONE);
  founder = await createTestUser('founder');
  await setPhone(founder.userId, FOUNDER_PHONE);
});

describe('founder-only access', () => {
  const FOUNDER_RPCS: Array<[string, Record<string, unknown>]> = [
    ['get_founder_kpis', {}],
    ['get_founder_call_lists', {}],
    ['get_founder_growth_stats', {}],
  ];

  it('the founder account can read every KPI RPC', async () => {
    for (const [fn, args] of FOUNDER_RPCS) {
      const { data, error } = await founder.client.rpc(fn, args);
      expect({ fn, error }).toEqual({ fn, error: null });
      expect(data).not.toBeNull();
    }
  });

  it('a vendeur is refused on every founder RPC', async () => {
    const owner = await createRealMerchant('Boutique du vendeur');
    const vendeur = await createTestUser('vendeur');
    await setPhone(vendeur.userId, randomGuineaPhone());
    await addMember(owner.businessId, vendeur.userId, 'vendeur');

    for (const [fn, args] of FOUNDER_RPCS) {
      const { data, error } = await vendeur.client.rpc(fn, args);
      expect({ fn, data }).toEqual({ fn, data: null });
      expect(error?.message).toBe('Accès refusé');
    }
    const { error } = await vendeur.client.rpc('set_business_is_test', { p_business_id: owner.businessId, p_is_test: true });
    expect(error?.message).toBe('Accès refusé');
  });

  it('an administrateur of another business is refused too', async () => {
    const other = await createRealMerchant('Autre commerce');
    for (const [fn, args] of FOUNDER_RPCS) {
      const { data, error } = await other.client.rpc(fn, args);
      expect({ fn, data }).toEqual({ fn, data: null });
      expect(error?.message).toBe('Accès refusé');
    }
    const { error } = await other.client.rpc('set_business_is_test', { p_business_id: other.businessId, p_is_test: true });
    expect(error?.message).toBe('Accès refusé');
    const { data: biz } = await admin.from('businesses').select('is_test').eq('id', other.businessId).single();
    expect(biz!.is_test).toBe(false);
  });

  it('an unauthenticated client cannot call any founder RPC', async () => {
    const anon = anonClient();
    for (const [fn, args] of FOUNDER_RPCS) {
      const { data, error } = await anon.rpc(fn, args);
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    }
  });

  it('nobody can read the underlying views or the device log directly, founder included', async () => {
    const vendeur = await createTestUser('reader');
    for (const client of [vendeur.client, founder.client, anonClient()]) {
      for (const rel of ['kpi_businesses', 'kpi_core_actions', 'kpi_business_activity',
                         'call_list_welcome', 'call_list_interview', 'call_list_referral',
                         'funnel_devices', 'growth_metrics']) {
        const { data, error } = await client.from(rel).select('*').limit(1);
        expect({ rel, data }).toEqual({ rel, data: null });
        expect(error).not.toBeNull();
      }
    }
  });

  it('the founder profile is auto-flagged as test', async () => {
    const { data } = await admin.from('profiles').select('is_test').eq('id', founder.userId).single();
    expect(data!.is_test).toBe(true);
  });
});

describe('is_test traffic never moves the founder numbers', () => {
  it('test businesses, the founder\'s own shop and test devices change nothing; a real shop does', async () => {
    const before = await snapshot(founder.client);

    // (a) A business the founder creates is test by construction.
    const founderBiz = await createTestBusiness(founder.client, 'Boutique du fondateur');
    const { data: fb } = await admin.from('businesses').select('is_test').eq('id', founderBiz).single();
    expect(fb!.is_test).toBe(true);
    await insertSale(founderBiz, founder.userId);
    await createTestProduct(founderBiz, founder.userId);

    // (b) A team member's shop the founder flags as test.
    const team = await createRealMerchant('Exemple — équipe');
    const { error: flagErr } = await founder.client.rpc('set_business_is_test', { p_business_id: team.businessId, p_is_test: true });
    expect(flagErr).toBeNull();
    await insertSale(team.businessId, team.userId);
    await insertSale(team.businessId, team.userId, 'credit');

    // (c) A test device going through the whole pre-commerce funnel.
    const testDevice = randomUUID();
    for (const step of ['installed', 'otp_sent', 'otp_verified']) {
      const { error } = await anonClient().rpc('record_funnel_step', {
        p_device_id: testDevice, p_step: step, p_platform: 'ios', p_is_test: true,
      });
      expect(error).toBeNull();
    }

    // (d) A device the founder's own session touches becomes test.
    const founderDevice = randomUUID();
    await anonClient().rpc('record_funnel_step', { p_device_id: founderDevice, p_step: 'installed' });
    await founder.client.rpc('record_funnel_step', { p_device_id: founderDevice, p_step: 'seen' });
    const { data: fd } = await admin.from('funnel_devices').select('is_test').eq('device_id', founderDevice).single();
    expect(fd!.is_test).toBe(true);

    const afterTest = await snapshot(founder.client);
    expect({ kpis: afterTest.kpis, lists: afterTest.lists }).toEqual({ kpis: before.kpis, lists: before.lists });
    // ...while the test/demo exclusion counter shows the two new test businesses ((a) and (b)).
    expect(afterTest.excludedTest).toBeGreaterThanOrEqual((before.excludedTest ?? 0) + 2);

    // Positive control: the same activity on a real shop DOES move them,
    // so the equality above isn't just a metric that never changes.
    const realDevice = randomUUID();
    await anonClient().rpc('record_funnel_step', { p_device_id: realDevice, p_step: 'installed', p_platform: 'android' });
    const real = await createRealMerchant('Boutique réelle');
    await real.client.rpc('record_funnel_step', { p_device_id: realDevice, p_step: 'otp_sent' });
    await real.client.rpc('record_funnel_step', { p_device_id: realDevice, p_step: 'otp_verified' });
    await insertSale(real.businessId, real.userId);

    const afterReal = await snapshot(founder.client);
    const b = before.kpis as any;
    const r = afterReal.kpis as any;
    expect(r.north_star.weekly[0]).toBe(b.north_star.weekly[0] + 1);
    expect(r.north_star.total_real_businesses).toBe(b.north_star.total_real_businesses + 1);
    expect(r.activation.cohort).toBe(b.activation.cohort + 1);
    expect(r.activation.activated).toBe(b.activation.activated + 1);
    expect(r.funnel.installed).toBe(b.funnel.installed + 1);
    expect(r.funnel.otp_verified).toBe(b.funnel.otp_verified + 1);
    expect(r.funnel.commerce).toBe(b.funnel.commerce + 1);
    expect(r.funnel.first_value).toBe(b.funnel.first_value + 1);
    const welcome = (afterReal.lists as any).welcome as Array<{ business_id: string }>;
    expect(welcome.map(w => w.business_id)).toContain(real.businessId);
    expect(welcome.map(w => w.business_id)).not.toContain(team.businessId);
    expect(welcome.map(w => w.business_id)).not.toContain(founderBiz);
  });

  it('a power user lands on the referral list, a silent activated shop on the interview list', async () => {
    const power = await createRealMerchant('Boutique très active');
    for (let d = 0; d < 5; d++) {
      const { error } = await admin.from('sale_orders').insert({
        business_id: power.businessId, seller_id: power.userId, created_by: power.userId,
        status: 'paye', total_amount: 100000,
        created_at: new Date(Date.now() - d * 86400000).toISOString(),
      });
      if (error) throw error;
    }
    const silent = await createRealMerchant('Boutique silencieuse');
    const { error } = await admin.from('sale_orders').insert({
      business_id: silent.businessId, seller_id: silent.userId, created_by: silent.userId,
      status: 'paye', total_amount: 100000,
      created_at: new Date(Date.now() - 10 * 86400000).toISOString(),
    });
    if (error) throw error;

    const { data } = await founder.client.rpc('get_founder_call_lists');
    const ids = (k: string) => ((data as any)[k] as Array<{ business_id: string }>).map(x => x.business_id);
    expect(ids('referral')).toContain(power.businessId);
    expect(ids('interview')).toContain(silent.businessId);
    expect(ids('interview')).not.toContain(power.businessId);
  });
});

describe('record_funnel_step input guard', () => {
  it('rejects an unknown step', async () => {
    const { error } = await anonClient().rpc('record_funnel_step', { p_device_id: randomUUID(), p_step: 'hacked' });
    expect(error?.message).toBe('Étape invalide');
  });

  it('keeps the earliest install time and never lets a client un-flag a test device', async () => {
    const device = randomUUID();
    const early = new Date(Date.now() - 3600_000).toISOString();
    await anonClient().rpc('record_funnel_step', { p_device_id: device, p_step: 'installed', p_is_test: true });
    await anonClient().rpc('record_funnel_step', { p_device_id: device, p_step: 'installed', p_at: early, p_is_test: false });
    const { data } = await admin.from('funnel_devices').select('installed_at, is_test').eq('device_id', device).single();
    expect(new Date(data!.installed_at).getTime()).toBe(new Date(early).getTime());
    expect(data!.is_test).toBe(true);
  });
  it('a real merchant\'s device is NOT flagged when the founder later logs in on it', async () => {
    const device = randomUUID();
    const merchant = await createRealMerchant('Boutique accompagnée');
    await anonClient().rpc('record_funnel_step', { p_device_id: device, p_step: 'installed' });
    await merchant.client.rpc('record_funnel_step', { p_device_id: device, p_step: 'otp_verified' });
    await founder.client.rpc('record_funnel_step', { p_device_id: device, p_step: 'seen' });
    const { data } = await admin.from('funnel_devices').select('is_test, user_id').eq('device_id', device).single();
    expect(data!.user_id).toBe(merchant.userId);
    expect(data!.is_test).toBe(false);
  });
});

describe('consumer invites are marked expired, not deleted', () => {
  it('keeps the row for the founder count and hides it from the merchant list', async () => {
    const inviter = await createRealMerchant('Parrain');
    const { data: first, error } = await inviter.client.rpc('create_consumer_invite');
    expect(error).toBeNull();
    const firstId = (first as { id: string }).id;
    await admin.from('consumer_invites').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', firstId);

    // The next creation used to DELETE the expired row.
    const { error: secondErr } = await inviter.client.rpc('create_consumer_invite');
    expect(secondErr).toBeNull();

    const { data: row } = await admin.from('consumer_invites').select('status').eq('id', firstId).single();
    expect(row!.status).toBe('expired');

    const { data: mine } = await inviter.client.rpc('list_my_consumer_invites');
    expect((mine as Array<{ id: string }>).map(i => i.id)).not.toContain(firstId);
  });
});
