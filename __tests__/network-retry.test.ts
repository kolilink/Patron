// withNetworkRetry() — confirms a network failure with one quick retry
// before a store trusts it enough to flip offline:true and show the "Hors
// ligne" banner. Guards the actual mechanism behind two real findings:
//
// 1. By default (no .throwOnError()), supabase-js never REJECTS on a
//    network failure — it resolves with `{ data: null, error: {...} }`
//    instead (see node_modules/@supabase/postgrest-js's PostgrestBuilder.ts,
//    executeWithRetry()). A version of this helper that only wrapped a
//    try/catch around a rejection would never actually fire for the common
//    case — these tests exist specifically to guard against silently
//    regressing back to that shape.
// 2. A single failed attempt is common, transient noise, especially on
//    Android (see CLAUDE.md's Wi-Fi Assist / OkHttp-fail-fast note) — only
//    a failure confirmed on a second, independent attempt should be
//    trusted as a real outage.

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
    from: jest.fn(),
    auth: {
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
  },
}));

jest.mock('@/lib/db', () => ({
  getPendingOps: jest.fn(),
  deleteQueueItem: jest.fn(),
  markAttemptFailed: jest.fn(),
  getQueueCount: jest.fn().mockResolvedValue(0),
}));

import { withNetworkRetry, reportOfflineFallback } from '@/lib/sync';
import * as Sentry from '@sentry/react-native';

const NETWORK_ERROR = { message: 'Network request failed' };
const SERVER_ERROR = { message: 'permission denied for table products' };

describe('withNetworkRetry — confirms a failure before trusting it', () => {
  it('returns the result on a clean first success, calling fn only once', async () => {
    const fn = jest.fn().mockResolvedValue({ data: [1, 2, 3], error: null });

    const result = await withNetworkRetry(fn);

    expect(result).toEqual({ data: [1, 2, 3], error: null });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a single network-shaped error result is NOT trusted — retries once, and a passing second attempt wins', async () => {
    const fn = jest.fn()
      .mockResolvedValueOnce({ data: null, error: NETWORK_ERROR })
      .mockResolvedValueOnce({ data: [1], error: null });

    const result = await withNetworkRetry(fn);

    expect(result).toEqual({ data: [1], error: null });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a network-shaped error confirmed on the retry too is returned as a real failure, not thrown', async () => {
    const fn = jest.fn().mockResolvedValue({ data: null, error: NETWORK_ERROR });

    const result = await withNetworkRetry(fn);

    expect(result).toEqual({ data: null, error: NETWORK_ERROR });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a non-network (server/permission) error result is trusted immediately — no retry', async () => {
    const fn = jest.fn().mockResolvedValue({ data: null, error: SERVER_ERROR });

    const result = await withNetworkRetry(fn);

    expect(result).toEqual({ data: null, error: SERVER_ERROR });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a rejected first attempt (e.g. withTimeout firing) is also retried once', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('Network timeout after 12000ms'))
      .mockResolvedValueOnce({ data: [1], error: null });

    const result = await withNetworkRetry(fn);

    expect(result).toEqual({ data: [1], error: null });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a rejected non-network error is never retried and propagates immediately', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('boom — some unrelated bug'));

    await expect(withNetworkRetry(fn)).rejects.toThrow('boom — some unrelated bug');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a rejected retry (both attempts network-shaped) propagates the retry error', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockRejectedValueOnce(new Error('Network request failed — still down'));

    await expect(withNetworkRetry(fn)).rejects.toThrow('Network request failed — still down');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('accepts a custom isFailure predicate — needed for a Promise.all() result, which has no top-level .error', async () => {
    // Mirrors stores/market.ts's fetchPosts: Promise.all([...]) resolves to
    // an array, not an {error} object, so the default predicate (which reads
    // result.error) would never see a failure — the call site must pass its
    // own check for the one element it actually cares about.
    const fn = jest.fn()
      .mockResolvedValueOnce([{ error: NETWORK_ERROR }, { error: null }])
      .mockResolvedValueOnce([{ error: null }, { error: null }]);

    const result = await withNetworkRetry(
      fn,
      12000,
      (results) => (results as Array<{ error: unknown }>)[0].error === NETWORK_ERROR,
    );

    expect(result).toEqual([{ error: null }, { error: null }]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('re-invokes fn() fresh on retry, not the already-settled first call — required since Supabase query builders are single-use thunks', async () => {
    let callCount = 0;
    const fn = jest.fn(() => {
      callCount++;
      return Promise.resolve(
        callCount === 1 ? { data: null, error: NETWORK_ERROR } : { data: [callCount], error: null },
      );
    });

    const result = await withNetworkRetry(fn);

    expect(result).toEqual({ data: [2], error: null });
  });
});

describe('reportOfflineFallback — Sentry visibility for real offline transitions', () => {
  beforeEach(() => {
    (Sentry.captureMessage as jest.Mock).mockClear();
  });

  it('captures the store/function context, platform, and the real underlying error message', () => {
    reportOfflineFallback('products.fetchProducts', new Error('Network request failed'));

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'store_offline_fallback',
      expect.objectContaining({
        extra: expect.objectContaining({
          context: 'products.fetchProducts',
          error: 'Network request failed',
        }),
      }),
    );
  });

  it('[regression guard] extracts the real message from a plain PostgrestError-shaped object, not "[object Object]"', () => {
    // Found by writing this very test: reportOfflineFallback() used to do
    // `err instanceof Error ? err.message : String(err)` — but by default
    // (no .throwOnError()) Supabase never rejects with an Error instance,
    // it resolves with a plain { message, code, details, hint } object, so
    // String(err) on the actual common case produced the literal text
    // "[object Object]" in every Sentry event, silently defeating the
    // entire point of capturing a diagnosable message.
    reportOfflineFallback('ventes.fetchSales', { message: 'Failed to fetch', code: '', details: '', hint: '' });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'store_offline_fallback',
      expect.objectContaining({
        extra: expect.objectContaining({ context: 'ventes.fetchSales', error: 'Failed to fetch' }),
      }),
    );
  });
});
