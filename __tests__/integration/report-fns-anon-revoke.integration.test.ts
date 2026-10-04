// migration_v226 — unauthenticated financial reads.
//
// get_reports_snapshot / get_period_report (SECURITY DEFINER) treat
// auth.uid() IS NULL as the trusted service path and believe the supplied
// p_role. anon used to hold EXECUTE, so a bare anon key + a business UUID read
// full financials. v226 revokes EXECUTE from PUBLIC/anon (grant-only change).
//
// Asserts: anon is refused at the privilege layer (permission denied, not a
// function-body error); authenticated callers stay governed by the functions'
// own is_member()/server-derived-role logic; the service_role path still works.
import { createTestUser, createTestBusiness, addMember, adminClient, anonClient } from './helpers';

const today = new Date().toISOString().slice(0, 10);

const snapshotArgs = (businessId: string, role = 'administrateur', userId: string | null = null) => ({
  p_business_id: businessId, p_period_days: 30, p_role: role, p_user_id: userId, p_today: today,
});
const periodArgs = (businessId: string, role = 'administrateur', userId: string | null = null) => ({
  p_business_id: businessId, p_period_start: today, p_period_end: today, p_role: role, p_user_id: userId,
});

const PERMISSION_DENIED = /permission denied/i;

describe('report functions — anon has no EXECUTE (v226)', () => {
  it('anon cannot call get_reports_snapshot, even claiming administrateur', async () => {
    const { client: owner } = await createTestUser('owner');
    const businessId = await createTestBusiness(owner, 'Commerce Cible');
    const { data, error } = await anonClient().rpc('get_reports_snapshot', snapshotArgs(businessId));
    expect(data).toBeNull();
    expect(error?.message).toMatch(PERMISSION_DENIED);
  });

  it('anon cannot call get_period_report, even claiming administrateur', async () => {
    const { client: owner } = await createTestUser('owner');
    const businessId = await createTestBusiness(owner, 'Commerce Cible');
    const { data, error } = await anonClient().rpc('get_period_report', periodArgs(businessId));
    expect(data).toBeNull();
    expect(error?.message).toMatch(PERMISSION_DENIED);
  });
});

describe('report functions — authenticated callers stay governed by internal logic', () => {
  it('a non-member authenticated user is refused by is_member (Accès refusé, not a privilege error)', async () => {
    const { client: owner } = await createTestUser('owner');
    const businessId = await createTestBusiness(owner, 'Commerce Cible');
    const { client: outsider } = await createTestUser('outsider');
    await createTestBusiness(outsider, 'Autre Commerce');

    const s = await outsider.rpc('get_reports_snapshot', snapshotArgs(businessId));
    expect(s.error?.message).toMatch(/Accès refusé/);
    const p = await outsider.rpc('get_period_report', periodArgs(businessId));
    expect(p.error?.message).toMatch(/Accès refusé/);
  });

  it('an admin member still gets the report', async () => {
    const { client: owner, userId } = await createTestUser('owner');
    const businessId = await createTestBusiness(owner, 'Commerce Cible');
    const s = await owner.rpc('get_reports_snapshot', snapshotArgs(businessId, 'administrateur', userId));
    expect(s.error).toBeNull();
    expect(s.data).toBeTruthy();
    const p = await owner.rpc('get_period_report', periodArgs(businessId, 'administrateur', userId));
    expect(p.error).toBeNull();
    expect(p.data).toBeTruthy();
  });

  it('a vendeur cannot escalate by passing p_role=administrateur (role is derived server-side)', async () => {
    const { client: owner } = await createTestUser('owner');
    const businessId = await createTestBusiness(owner, 'Commerce Cible');
    const { client: seller, userId: sellerId } = await createTestUser('vendeur');
    await addMember(businessId, sellerId, 'vendeur');

    // Give the business real money so "sees it" vs "doesn't" is meaningful.
    const inj = await owner.rpc('record_injection', { p_business_id: businessId, p_amount: 50000 });
    expect(inj.error).toBeNull();

    const real = await owner.rpc('get_period_report', periodArgs(businessId));
    expect(real.error).toBeNull();
    expect(real.data.role).toBe('administrateur');
    expect(real.data.cash_on_hand).toBe(50000);   // admin view has business-wide money

    // Forged role: server ignores p_role and derives 'vendeur' from the membership.
    const forged = await seller.rpc('get_period_report', periodArgs(businessId, 'administrateur', sellerId));
    expect(forged.error).toBeNull();
    expect(forged.data.role).toBe('vendeur');
    expect(forged.data.cash_on_hand).toBe(0);
    expect(forged.data.net_profit).toBe(0);

    const forgedSnap = await seller.rpc('get_reports_snapshot', snapshotArgs(businessId, 'administrateur', sellerId));
    expect(forgedSnap.error).toBeNull();
    expect(forgedSnap.data.role).toBe('vendeur');
    expect(forgedSnap.data.cash_on_hand).toBe(0);
  });
});

describe('report functions — service_role path still works (v226)', () => {
  it('service_role can call both, supplying its own role', async () => {
    const { client: owner, userId } = await createTestUser('owner');
    const businessId = await createTestBusiness(owner, 'Commerce Cible');
    const admin = adminClient();
    const s = await admin.rpc('get_reports_snapshot', snapshotArgs(businessId, 'administrateur', userId));
    expect(s.error).toBeNull();
    expect(s.data).toBeTruthy();
    const p = await admin.rpc('get_period_report', periodArgs(businessId, 'administrateur', userId));
    expect(p.error).toBeNull();
    expect(p.data).toBeTruthy();
  });
});
