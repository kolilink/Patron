// lib/haptics.ts — the 4 Jony Ive moments.
// These guard that the right expo-haptics method fires for each event,
// and that hardware failures are silently swallowed (fire-and-forget contract).

import * as Haptics from 'expo-haptics';
import { haptics } from '@/lib/haptics';

// The haptics functions are fire-and-forget async IIFEs.
// This flushes the microtask queue so the mock gets called before we assert.
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('haptics.tap — product add / qty adjust', () => {
  it('calls impactAsync(Light) once', async () => {
    haptics.tap();
    await flush();
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
  });

  it('returns undefined (fire-and-forget, no promise leaks)', () => {
    const result = haptics.tap();
    expect(result).toBeUndefined();
  });

  it('does not throw when impactAsync rejects (broken motor)', async () => {
    (Haptics.impactAsync as jest.Mock).mockRejectedValueOnce(new Error('Vibration unavailable'));
    expect(() => haptics.tap()).not.toThrow();
    await flush();
    // No unhandled rejection propagates
  });
});

describe('haptics.success — sale confirmed / expense approved', () => {
  it('calls notificationAsync with Success type', async () => {
    haptics.success();
    await flush();
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success,
    );
  });

  it('returns undefined', () => {
    expect(haptics.success()).toBeUndefined();
  });

  it('does not throw when notificationAsync rejects', async () => {
    (Haptics.notificationAsync as jest.Mock).mockRejectedValueOnce(new Error('Vibration unavailable'));
    expect(() => haptics.success()).not.toThrow();
    await flush();
  });
});

describe('haptics.error — failed action / expense rejected', () => {
  it('calls notificationAsync with Error type', async () => {
    haptics.error();
    await flush();
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Error,
    );
  });

  it('returns undefined', () => {
    expect(haptics.error()).toBeUndefined();
  });

  it('does not throw when notificationAsync rejects', async () => {
    (Haptics.notificationAsync as jest.Mock).mockRejectedValueOnce(new Error('Vibration unavailable'));
    expect(() => haptics.error()).not.toThrow();
    await flush();
  });
});

describe('haptics — no cross-contamination between calls', () => {
  it('tap does not trigger notificationAsync', async () => {
    haptics.tap();
    await flush();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });

  it('success and error call notificationAsync with different types', async () => {
    haptics.success();
    haptics.error();
    await flush();
    expect(Haptics.notificationAsync).toHaveBeenNthCalledWith(1, Haptics.NotificationFeedbackType.Success);
    expect(Haptics.notificationAsync).toHaveBeenNthCalledWith(2, Haptics.NotificationFeedbackType.Error);
  });
});
