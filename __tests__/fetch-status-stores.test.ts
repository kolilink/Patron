// Data-state invariant (CLAUDE.md "Data-state invariant", lib/fetchStatus.ts),
// proven per store against a Supabase stub whose result the test controls:
//   (a) a first fetch that returns [] settles 'ready' — a skeleton can never
//       render for it (resolveDataState('ready', true) === 'empty');
//   (b) a second fetch on a 'ready' store is silent: status stays 'ready' and
//       `loading` is never true at any point;
//   (c) reset() (what a business switch runs) returns the store to 'idle';
//   (d) a failing first fetch settles 'error', and the retry re-enters 'loading'.

let mockResult: { data: unknown; error: unknown } = { data: [], error: null };
let mockHold: Promise<void> | null = null;

function builder(): any {
  const settle = () => (mockHold ?? Promise.resolve()).then(() => mockResult);
  return new Proxy({}, {
    get: (_t, key) => {
      if (key === 'then') return (res: any, rej: any) => settle().then(res, rej);
      if (key === 'catch') return (rej: any) => settle().catch(rej);
      if (key === 'finally') return (f: any) => settle().finally(f);
      return () => builder();
    },
  });
}

jest.mock('@/lib/supabase', () => ({
  supabase: { from: jest.fn(() => builder()), rpc: jest.fn(() => builder()), auth: { onAuthStateChange: jest.fn() } },
}));
jest.mock('@/lib/sync', () => ({
  isNetworkError: jest.fn(() => false),
  withTimeout: jest.fn((p: unknown) => p),
  withNetworkRetry: jest.fn((fn: () => unknown) => fn()),
  reportOfflineFallback: jest.fn(),
}));
jest.mock('@/lib/db', () => new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '__esModule') return false;
    if (key === 'getAllQueueItemsForOverlay') return async () => ({ ok: [], corrupt: [] });
    if (key === 'getQueueCount' || key === 'getFailedQueueCount') return async () => 0;
    return async () => null;
  },
}));
jest.mock('@/lib/errors', () => ({ translateError: jest.fn(() => 'err') }));
jest.mock('@/lib/id', () => ({ generateId: jest.fn(() => 'id'), generateFallbackName: jest.fn(() => 'Membre') }));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/stores/sync', () => ({ useSyncStore: { getState: () => ({ kick: jest.fn() }), setState: jest.fn() } }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn(), resolveSellerDisplayName: jest.fn() }));
jest.mock('@/stores/auth', () => ({
  useAuthStore: {
    getState: () => ({
      session: {
        activeBusiness: { id: 'biz-1', currency: 'GNF' },
        activeMembership: { role: 'administrateur' },
        user: { id: 'u1', name: 'Fatou' },
      },
    }),
  },
}));

import { resolveDataState } from '@/src/components/ui/dataState';
import { useProductStore } from '@/stores/products';
import { useExpensesStore } from '@/stores/expenses';
import { useFournisseursStore } from '@/stores/fournisseurs';
import { useEquipeStore } from '@/stores/equipe';
import { useInvestorStore } from '@/stores/investor';
import { useAportsStore } from '@/stores/apports';
import { useVentesStore } from '@/stores/ventes';
import { useModerationStore } from '@/stores/moderation';
import { useAlphaStore } from '@/stores/alpha';
import { useMarketStore } from '@/stores/market';
import { useChatStore } from '@/stores/chat';

interface Case {
  name: string;
  store: { getState: () => any; setState: (s: any) => void; subscribe: (l: (s: any) => void) => () => void };
  /** Status key on the store this fetch drives (default fetchStatus). */
  key?: string;
  fetch: () => Promise<unknown>;
  /** What the "genuinely empty" server answers. */
  empty: { data: unknown; error: unknown };
}

const ok = (data: unknown) => ({ data, error: null });
const cases: Case[] = [
  { name: 'products', store: useProductStore as any, fetch: () => useProductStore.getState().fetchProducts('biz-1', 'u1', undefined, 'administrateur'), empty: ok([]) },
  { name: 'expenses', store: useExpensesStore as any, fetch: () => useExpensesStore.getState().fetchExpenses('biz-1'), empty: ok([]) },
  { name: 'fournisseurs', store: useFournisseursStore as any, fetch: () => useFournisseursStore.getState().fetchFournisseurs('biz-1'), empty: ok([]) },
  { name: 'fournisseurs (commandes)', store: useFournisseursStore as any, key: 'commandesStatus', fetch: () => useFournisseursStore.getState().fetchCommandes('biz-1'), empty: ok([]) },
  { name: 'equipe (membres)', store: useEquipeStore as any, fetch: () => useEquipeStore.getState().fetchMembres('biz-1'), empty: ok([]) },
  { name: 'equipe (codes)', store: useEquipeStore as any, key: 'codesStatus', fetch: () => useEquipeStore.getState().fetchCodes('biz-1'), empty: ok([]) },
  { name: 'investor (payouts)', store: useInvestorStore as any, fetch: () => useInvestorStore.getState().fetchPayouts('biz-1', 'inv-1'), empty: ok([]) },
  { name: 'investor (balance)', store: useInvestorStore as any, key: 'balanceStatus', fetch: () => useInvestorStore.getState().fetchBalance('biz-1', 'inv-1'), empty: ok(null) },
  { name: 'apports', store: useAportsStore as any, fetch: () => useAportsStore.getState().fetchApports('biz-1'), empty: ok([]) },
  { name: 'ventes', store: useVentesStore as any, fetch: () => useVentesStore.getState().fetchSales('biz-1'), empty: ok([]) },
  { name: 'market', store: useMarketStore as any, fetch: () => useMarketStore.getState().fetchPosts('u1'), empty: ok([]) },
  { name: 'chat', store: useChatStore as any, fetch: () => useChatStore.getState().load('biz-1', 'u1'), empty: ok([]) },
  { name: 'moderation', store: useModerationStore as any, fetch: () => useModerationStore.getState().fetchReports(), empty: ok([]) },
];

beforeAll(() => { jest.spyOn(console, 'error').mockImplementation(() => {}); });

beforeEach(() => {
  mockHold = null;
  mockResult = { data: [], error: null };
  useProductStore.getState().reset();
  useExpensesStore.getState().reset();
  useFournisseursStore.getState().reset();
  useEquipeStore.getState().reset();
  useInvestorStore.getState().reset();
  useAportsStore.getState().reset();
  useVentesStore.getState().reset();
  useModerationStore.getState().reset();
  useMarketStore.getState().reset();
  useChatStore.getState().reset();
});

describe.each(cases)('$name — fetch status invariant', (c) => {
  const key = c.key ?? 'fetchStatus';
  const status = () => c.store.getState()[key];

  it('starts idle', () => {
    expect(status()).toBe('idle');
  });

  it('(a) a first fetch returning an empty list settles ready — never a skeleton', async () => {
    mockResult = c.empty;
    await c.fetch();
    expect(status()).toBe('ready');
    expect(c.store.getState().loading === true).toBe(false);
    // ready + no rows is the screen's own empty state, never the skeleton.
    expect(resolveDataState(status(), true)).toBe('empty');
  });

  it('is loading while the first fetch is in flight (and only then renders a skeleton)', async () => {
    let release!: () => void;
    mockHold = new Promise<void>(r => { release = r; });
    mockResult = c.empty;
    const p = c.fetch();
    await Promise.resolve();
    await Promise.resolve();
    expect(status()).toBe('loading');
    expect(resolveDataState(status(), true)).toBe('skeleton');
    release();
    await p;
    expect(status()).toBe('ready');
  });

  it('(b) a second fetch is a silent refresh: status stays ready, loading never true', async () => {
    mockResult = c.empty;
    await c.fetch();
    expect(status()).toBe('ready');

    const seen: Array<{ status: string; loading: unknown }> = [];
    const unsub = c.store.subscribe((s: any) => seen.push({ status: s[key], loading: s.loading }));
    await c.fetch();
    unsub();

    expect(status()).toBe('ready');
    expect(seen.every(x => x.status === 'ready')).toBe(true);
    expect(seen.some(x => x.loading === true)).toBe(false);
  });

  it('(c) reset (a business switch) returns the store to idle', async () => {
    mockResult = c.empty;
    await c.fetch();
    expect(status()).toBe('ready');
    c.store.getState().reset();
    expect(status()).toBe('idle');
    expect(resolveDataState(status(), true)).toBe('skeleton');
  });

  it('(d) a failing first fetch settles error; the retry re-enters loading then ready', async () => {
    mockResult = { data: null, error: { message: 'boom', code: 'XX000' } };
    await c.fetch();
    expect(status()).toBe('error');
    expect(c.store.getState().loading === true).toBe(false);

    const seen: string[] = [];
    const unsub = c.store.subscribe((s: any) => seen.push(s[key]));
    mockResult = c.empty;
    await c.fetch();
    unsub();
    expect(seen[0]).toBe('loading');
    expect(status()).toBe('ready');
  });

  it('a failed background refresh keeps the data on screen (stays ready)', async () => {
    mockResult = c.empty;
    await c.fetch();
    mockResult = { data: null, error: { message: 'boom', code: 'XX000' } };
    await c.fetch();
    expect(status()).toBe('ready');
  });
});

describe('alpha store', () => {
  beforeEach(() => useAlphaStore.getState().reset());

  it('a conversation with zero messages settles ready, then refreshes silently', async () => {
    const { supabase } = require('@/lib/supabase');
    (supabase.rpc as jest.Mock).mockImplementation(() => {
      const b: any = builder();
      return b;
    });
    mockResult = { data: { id: 'conv-1' }, error: null };
    await useAlphaStore.getState().load('biz-1');
    expect(useAlphaStore.getState().fetchStatus).toBe('ready');

    const seen: boolean[] = [];
    const unsub = useAlphaStore.subscribe(s => seen.push(s.loading));
    await useAlphaStore.getState().load('biz-1');
    unsub();
    expect(seen.some(Boolean)).toBe(false);
    useAlphaStore.getState().reset();
    expect(useAlphaStore.getState().fetchStatus).toBe('idle');
  });
});
