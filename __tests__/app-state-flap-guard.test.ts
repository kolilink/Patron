// debounceAppStateHandler() — guards against Android's rapid AppState
// 'active'/'background' flapping (confirmed live via real PostHog session
// data: dozens of transitions per second with nobody touching the phone).
// app/(app)/_layout.tsx's two AppState listeners used to react to every
// raw transition — reopening a realtime channel and re-fetching the
// business/draining the sync queue each time — so a flapping burst kept
// the JS thread busy reacting to a phantom signal instead of responding to
// real taps, which is what actually read as "the app is slow." These tests
// guard the actual debounce mechanism, independent of the two call sites
// that use it.

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

import { debounceAppStateHandler, APP_STATE_FLAP_GUARD_MS } from '@/lib/sync';

describe('debounceAppStateHandler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('a single transition fires the real handler once, after the guard delay', () => {
    const handler = jest.fn();
    const { onChange } = debounceAppStateHandler(handler);

    onChange('background');
    expect(handler).not.toHaveBeenCalled();

    jest.advanceTimersByTime(APP_STATE_FLAP_GUARD_MS);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('background');
  });

  it('a burst of rapid flapping (the real Android bug) collapses into exactly one call, with the latest state', () => {
    const handler = jest.fn();
    const { onChange } = debounceAppStateHandler(handler);

    // Simulates the real PostHog data: dozens of transitions well under
    // APP_STATE_FLAP_GUARD_MS apart, ending on 'active'.
    for (let i = 0; i < 40; i++) {
      onChange(i % 2 === 0 ? 'background' : 'active');
      jest.advanceTimersByTime(150);
    }
    onChange('active');

    // None of the 40 flaps should have fired the real handler — each one
    // reset the timer before it could complete.
    expect(handler).not.toHaveBeenCalled();

    jest.advanceTimersByTime(APP_STATE_FLAP_GUARD_MS);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('active');
  });

  it('cancel() prevents a pending call from ever firing (e.g. effect cleanup on logout)', () => {
    const handler = jest.fn();
    const { onChange, cancel } = debounceAppStateHandler(handler);

    onChange('active');
    cancel();
    jest.advanceTimersByTime(APP_STATE_FLAP_GUARD_MS * 2);

    expect(handler).not.toHaveBeenCalled();
  });

  it('cancel() after the handler already fired is a safe no-op', () => {
    const handler = jest.fn();
    const { onChange, cancel } = debounceAppStateHandler(handler);

    onChange('active');
    jest.advanceTimersByTime(APP_STATE_FLAP_GUARD_MS);
    expect(handler).toHaveBeenCalledTimes(1);

    expect(() => cancel()).not.toThrow();
  });

  it('two transitions spaced further apart than the guard delay both fire independently', () => {
    const handler = jest.fn();
    const { onChange } = debounceAppStateHandler(handler);

    onChange('background');
    jest.advanceTimersByTime(APP_STATE_FLAP_GUARD_MS);
    onChange('active');
    jest.advanceTimersByTime(APP_STATE_FLAP_GUARD_MS);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, 'background');
    expect(handler).toHaveBeenNthCalledWith(2, 'active');
  });
});
