// Post-Face-ID unlock must feel instant: (A) Accueil's KPIs are a stale-while-revalidate
// snapshot that survives the lock screen's remount; (B) the encrypted session cache is
// read with one parallel IPC wave. Component rendering can't be tested here (no JSX
// transform in this jest setup), so (A)'s screen wiring is guarded at the source level
// and its state machine is tested through the snapshot module itself.

jest.mock('@/lib/supabase', () => ({
    supabase: {
        rpc: jest.fn(),
        from: jest.fn(),
        auth: {
            getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
            onAuthStateChange: jest.fn(() => ({
                data: { subscription: { unsubscribe: jest.fn() } },
            })),
            refreshSession: jest.fn(),
        },
        functions: { invoke: jest.fn() },
    },
    clearSupabaseLocalSession: jest.fn(),
    revokeAccessToken: jest.fn(),
}));

jest.mock('@/lib/db', () => ({
    enqueue: jest.fn(),
    getQueueCount: jest.fn().mockResolvedValue(0),
    openDb: jest.fn(),
    setKV: jest.fn().mockResolvedValue(undefined),
    getKV: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn(), resetAnalytics: jest.fn(), identifyUser: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));

jest.mock('@/lib/sync', () => {
    const actual = jest.requireActual('@/lib/sync');
    return {
        ...actual,
        reportOfflineFallback: jest.fn(),
    };
});

import fs from 'fs';
import path from 'path';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import { useAuthStore } from '@/stores/auth';
import { getKpiSnapshot, setKpiSnapshot, clearKpiSnapshot } from '@/src/utils/kpiSnapshot';
import type { AppSession } from '@/src/types';

const CACHE_KEY = 'patron_session_cache_v1';
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const KPIS = { revenue_today: 1000, revenue_month: 5000 };

beforeEach(async () => {
  clearKpiSnapshot();
  await SecureStore.deleteItemAsync(`${CACHE_KEY}_count`);
  for (let i = 0; i < 5; i++) await SecureStore.deleteItemAsync(`${CACHE_KEY}_${i}`);
  (LocalAuthentication.isEnrolledAsync as jest.Mock).mockResolvedValue(true);
  (LocalAuthentication.authenticateAsync as jest.Mock).mockResolvedValue({ success: true });
  useAuthStore.setState({ session: null, loading: false, locked: true, error: null });
});

describe('A. KPI snapshot (stale-while-revalidate)', () => {
  it('(1) a same-business remount starts WITH the cached KPIs and NO loading state', () => {
    setKpiSnapshot('biz-1', KPIS);
    // exactly the two initializers the screen uses
    const initialKpis = getKpiSnapshot<typeof KPIS>('biz-1');
    const initialLoading = getKpiSnapshot('biz-1') === null;
    expect(initialKpis).toEqual(KPIS);
    expect(initialLoading).toBe(false);
  });

  it('(2) a business switch finds NO snapshot → nulls the numbers and shows the skeleton, as before', () => {
    setKpiSnapshot('biz-1', KPIS);
    expect(getKpiSnapshot('biz-2')).toBeNull();
    expect(getKpiSnapshot('biz-2') === null).toBe(true);   // initial loading = true
    expect(getKpiSnapshot('')).toBeNull();                 // no business yet
  });

  it('(3) logout clears the snapshot (a vendeur\'s numbers must not reach the next user)', async () => {
    setKpiSnapshot('biz-1', KPIS);
    expect(getKpiSnapshot('biz-1')).not.toBeNull();
    await useAuthStore.getState().logout();
    expect(getKpiSnapshot('biz-1')).toBeNull();
  });

  it('a soft lock does NOT clear it (same person coming back)', async () => {
    setKpiSnapshot('biz-1', KPIS);
    await useAuthStore.getState().lock();
    expect(getKpiSnapshot('biz-1')).not.toBeNull();
  });

  it('never stores an empty value or an empty business id', () => {
    setKpiSnapshot('', KPIS); setKpiSnapshot('biz-1', null);
    expect(getKpiSnapshot('biz-1')).toBeNull();
  });

  describe('screen wiring', () => {
    const src = read('app/(app)/(tabs)/index.tsx');
    it('state is seeded from the snapshot (no skeleton on first paint)', () => {
      expect(src).toMatch(/useState<KPIs \| null>\(\(\) => getKpiSnapshot<KPIs>\(businessId\)\)/);
      expect(src).toMatch(/useState\(\(\) => getKpiSnapshot<KPIs>\(businessId\) === null\)/);
    });
    it('loadAll blanks + skeletons ONLY when there is no snapshot for this business', () => {
      expect(src).toMatch(/const haveSnapshot = getKpiSnapshot<KPIs>\(businessId\) !== null;\s*if \(!haveSnapshot\) \{\s*setLoading\(true\);\s*setBestSellersBase\(\[\]\);\s*setKpis\(null\);\s*setKpisBase\(null\);/);
    });
    it('the DISPLAYED (post-overlay) numbers are stored on every successful load', () => {
      expect(src).toMatch(/const shownFresh = await withOutbox\(freshKpis\);\s*setKpis\(shownFresh\);\s*setKpiSnapshot\(businessId, shownFresh\)/);
    });
    it('the auth store clears it in logout()', () => {
      expect(read('stores/auth.ts')).toMatch(/resetAllStores\(\);[\s\S]{0,200}clearKpiSnapshot\(\);/);
    });
  });
});

describe('B. restoreSessionCache reads every chunk in parallel', () => {
  const session = { user: { id: 'u' }, memberships: [], activeBusiness: null, activeMembership: null } as unknown as AppSession;
  const chunksOf = (json: string, n: number) => {
    const size = Math.ceil(json.length / n);
    return Array.from({ length: n }, (_, i) => json.slice(i * size, (i + 1) * size));
  };

  it('issues all chunk reads before any resolves, and restores the same session', async () => {
    const parts = chunksOf(JSON.stringify(session), 4);
    await SecureStore.setItemAsync(`${CACHE_KEY}_count`, String(parts.length));
    for (let i = 0; i < parts.length; i++) await SecureStore.setItemAsync(`${CACHE_KEY}_${i}`, parts[i]);

    // getItemAsync is already a jest.fn (the in-memory SecureStore mock): wrap its own
    // implementation to measure how many chunk reads are in flight at once.
    const mock = SecureStore.getItemAsync as jest.Mock;
    const realImpl = mock.getMockImplementation()!;
    let inFlight = 0; let maxInFlight = 0;
    mock.mockImplementation(async (key: string) => {
      if (key.startsWith(`${CACHE_KEY}_`) && !key.endsWith('_count')) {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 15));
        inFlight--;
      }
      return realImpl(key);
    });
    try {
      const result = await useAuthStore.getState().unlockWithBiometric();
      expect(result).toBe('unlocked');
      expect(useAuthStore.getState().session).toEqual(session);
      expect(maxInFlight).toBe(parts.length);   // sequential reads would peak at 1
    } finally {
      mock.mockImplementation(realImpl);
    }
  });

  it('a missing chunk still means "no usable cache" (same semantics as before)', async () => {
    const parts = chunksOf(JSON.stringify(session), 3);
    await SecureStore.setItemAsync(`${CACHE_KEY}_count`, '3');
    await SecureStore.setItemAsync(`${CACHE_KEY}_0`, parts[0]);
    await SecureStore.setItemAsync(`${CACHE_KEY}_2`, parts[2]);   // chunk 1 absent
    await useAuthStore.getState().unlockWithBiometric();
    expect(useAuthStore.getState().session).toBeNull();
  });

  it('source: one Promise.all over the chunk keys, no sequential await loop', () => {
    const src = read('stores/auth.ts');
    expect(src).toMatch(/const chunks = await Promise\.all\(\s*Array\.from\(\{ length: count \}/);
    expect(src).not.toMatch(/for \(let i = 0; i < count; i\+\+\) \{\s*const chunk = await SecureStore\.getItemAsync/);
  });
});
