// Team feature flag (businesses.teams_enabled, migration_v227) — client side.
//
// Visibility only, fail-open, no data deleted anywhere. React components have
// no unit tests in this repo (no JSX transform), so the gating logic lives in
// pure helpers (src/utils/teamsFlag.ts) that the screens and these tests
// share, plus source-level guards that the screens actually use them.
import * as fs from 'fs';
import * as path from 'path';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
    from: jest.fn(),
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    functions: { invoke: jest.fn() },
  },
}));
jest.mock('@/lib/db', () => ({
  enqueue: jest.fn(),
  getQueueCount: jest.fn().mockResolvedValue(0),
  openDb: jest.fn(),
  setKV: jest.fn().mockResolvedValue(undefined),
  getKV: jest.fn().mockResolvedValue(null),
}));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth';
import { isTeamsEnabled, teamSurfaces } from '@/src/utils/teamsFlag';
import type { Business, Membership } from '@/src/types';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('isTeamsEnabled — fail-open', () => {
  it('false hides; true shows', () => {
    expect(isTeamsEnabled({ teams_enabled: false })).toBe(false);
    expect(isTeamsEnabled({ teams_enabled: true })).toBe(true);
  });
  it.each([
    ['undefined flag (old server)', {}],
    ['null flag', { teams_enabled: null }],
    ['no business', undefined],
    ['null business', null],
  ])('%s → shown (never hide on an unknown flag)', (_l, b) => {
    expect(isTeamsEnabled(b as any)).toBe(true);
  });
});

describe('teamSurfaces', () => {
  it('flag false → every team surface hidden, default Discussions tab is Le Marché (Amis is flagged off)', () => {
    expect(teamSurfaces({ teams_enabled: false })).toEqual({
      equipeEntry: false, apportsEntry: false, maBoutiqueTab: false, roleBadges: false,
      defaultDiscussionsTab: 'marche',
    });
  });
  it('flag true → everything shown, default tab is Ma Boutique', () => {
    expect(teamSurfaces({ teams_enabled: true })).toEqual({
      equipeEntry: true, apportsEntry: true, maBoutiqueTab: true, roleBadges: true,
      defaultDiscussionsTab: 'boutique',
    });
  });
  it('undefined flag → everything visible (today\'s behavior)', () => {
    const s = teamSurfaces({} as any);
    expect(Object.values(s).slice(0, 4)).toEqual([true, true, true, true]);
    expect(s.defaultDiscussionsTab).toBe('boutique');
  });
});

describe('screens actually use the flag (source guards)', () => {
  const plus = read('app/(app)/(tabs)/plus.tsx');
  it('Plus: every Équipe / Apports route is behind teamsEnabled', () => {
    const rows = plus.split('\n').filter(l => /router\.push\('\/(equipe|apports)'\)/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(4); // Mes apports, Apports ×2, Équipe
    for (const l of rows) expect(l).toMatch(/teamsEnabled &&/);
  });
  it('Plus: the "Vous êtes {rôle}" badge is behind teamsEnabled', () => {
    const i = plus.indexOf('Vous êtes ${');
    expect(i).toBeGreaterThan(0);
    expect(plus.slice(Math.max(0, i - 700), i)).toMatch(/\{teamsEnabled && \(/);
  });
  it('Discussions: the Ma Boutique tab is behind the enabled-tabs config and the tab is resolved', () => {
    const d = read('app/(app)/discussions.tsx');
    expect(d).toMatch(/\{enabledTabs\.includes\('boutique'\) && \(\s*<Pressable\s+onPress=\{\(\) => handleTabChange\('boutique'\)\}/);
    expect(d).toMatch(/resolveActiveTab\(tabState, enabledTabs\)/);
  });
  it('BusinessDrawer: role labels are behind the per-business flag', () => {
    expect(read('src/components/BusinessDrawer.tsx')).toMatch(/isTeamsEnabled\(m\.business\) &&/);
  });
});

describe('refreshTeamsFlag (store)', () => {
  const biz = (id: string, extra: Partial<Business> = {}): Business => ({
    id, name: id, type: null, currency: 'GNF', logo_url: null, status: 'actif',
    subscription_tier: 'gratuit', subscription_status: 'trialing', trial_ends_at: null,
    stripe_customer_id: null, subscription_expires_at: null, phone: null,
    payment_provider: null, revenuecat_customer_id: null, bonus_access_until: null,
    referred_by_business_id: null, referral_code: null, first_run_hero_completed_at: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', created_by: 'u1', ...extra,
  });
  const mem = (b: Business): Membership => ({
    id: `m-${b.id}`, user_id: 'u1', business_id: b.id, role: 'administrateur',
    joined_at: '2026-01-01T00:00:00Z', milestone_reached: false, business: b,
  });
  const setSession = (b: Business) => useAuthStore.setState({
    session: {
      user: { id: 'u1', name: 'N', email: '', phone: null, avatar_url: null, language: 'fr', recovery_email: null,
        notify_on_every_sale: true, created_at: '', updated_at: '' } as any,
      memberships: [mem(b)], activeBusiness: b, activeMembership: mem(b),
    },
    loading: false, error: null,
  });
  const mockServer = (result: { data: any; error: any } | Error) => {
    (supabase.from as jest.Mock).mockReturnValue({
      select: () => ({ eq: () => ({ single: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)) }) }),
    });
  };

  it('false → true: the flag is updated on the business AND its membership copy', async () => {
    setSession(biz('b1', { teams_enabled: false }));
    mockServer({ data: { teams_enabled: true }, error: null });
    await useAuthStore.getState().refreshTeamsFlag();
    const s = useAuthStore.getState().session!;
    expect(s.activeBusiness!.teams_enabled).toBe(true);
    expect((s.memberships[0].business as Business).teams_enabled).toBe(true);
  });

  it('true → false works too', async () => {
    setSession(biz('b1', { teams_enabled: true }));
    mockServer({ data: { teams_enabled: false }, error: null });
    await useAuthStore.getState().refreshTeamsFlag();
    expect(useAuthStore.getState().session!.activeBusiness!.teams_enabled).toBe(false);
  });

  it.each([
    ['server error (e.g. column missing on an old server)', { data: null, error: { message: 'column does not exist' } }],
    ['missing row', { data: null, error: null }],
    ['undefined flag in the response', { data: {}, error: null }],
    ['network failure', new Error('Network request failed')],
  ])('%s → leaves the cached value untouched (fail-open)', async (_l, result) => {
    setSession(biz('b1', { teams_enabled: false }));
    mockServer(result as any);
    await useAuthStore.getState().refreshTeamsFlag();
    expect(useAuthStore.getState().session!.activeBusiness!.teams_enabled).toBe(false);
  });

  it('never invents a value: an unknown flag stays undefined (= shown)', async () => {
    setSession(biz('b1')); // no teams_enabled at all (old cached session)
    mockServer({ data: null, error: { message: 'boom' } });
    await useAuthStore.getState().refreshTeamsFlag();
    expect(useAuthStore.getState().session!.activeBusiness!.teams_enabled).toBeUndefined();
    expect(isTeamsEnabled(useAuthStore.getState().session!.activeBusiness)).toBe(true);
  });

  it('ignores a response that lands after the user switched business', async () => {
    const b1 = biz('b1', { teams_enabled: false });
    const b2 = biz('b2', { teams_enabled: false });
    setSession(b1);
    let resolve!: (v: any) => void;
    (supabase.from as jest.Mock).mockReturnValue({
      select: () => ({ eq: () => ({ single: () => new Promise(r => { resolve = r; }) }) }),
    });
    const pending = useAuthStore.getState().refreshTeamsFlag();
    useAuthStore.setState(st => ({ session: { ...st.session!, activeBusiness: b2, activeMembership: mem(b2) } }));
    resolve({ data: { teams_enabled: true }, error: null });
    await pending;
    expect(useAuthStore.getState().session!.activeBusiness!.id).toBe('b2');
    expect(useAuthStore.getState().session!.activeBusiness!.teams_enabled).toBe(false);
  });
});

describe('flag is visibility-only — no data-deleting code paths', () => {
  const FILES = ['src/utils/teamsFlag.ts', 'src/hooks/useTeamsEnabled.ts', 'db/migration_v227.sql'];
  it.each(FILES)('%s contains no delete / drop / truncate', (f) => {
    const code = read(f).split('\n').filter(l => !/^\s*(--|\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/\.delete\(|\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
  });
  it('refreshTeamsFlag only ever selects (read) — no write to businesses', () => {
    const src = read('stores/auth.ts');
    const start = src.indexOf('refreshTeamsFlag: async');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('clearTrialWelcome: () =>', start));
    expect(body.length).toBeGreaterThan(100);
    expect(body).toMatch(/\.select\('teams_enabled'\)/);
    expect(body).not.toMatch(/\.(update|delete|insert|upsert)\(/);
  });
});
