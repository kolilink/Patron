// lib/haptics.ts — semantic haptics contract.
//
// Guards three things:
//   1. Each helper routes the right intent to the right expo-haptics primitive
//      per platform (iOS vs Android performAndroidHapticsAsync + AndroidHaptics).
//   2. The Android API-level fallback ladder (30/34 thresholds) picks the
//      correct AndroidHaptics enum value.
//   3. The master toggle silences everything; fire-and-forget never throws;
//      throttledSelect collapses rapid taps.
//
// The expo-haptics mock is shared (__mocks__/expo-haptics.js); Platform.OS and
// Platform.Version live on the mutable react-native mock so tests flip them.

import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import {
  haptics,
  setEnabled,
  isHapticsEnabled,
  HAPTICS_KV_KEY,
} from '@/lib/haptics';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

// Re-importable overrides: lib/haptics reads Platform.OS / Platform.Version
// lazily at call time, so mutating the mock object is enough — no re-import
// needed.
const rnPlatform = Platform as unknown as { OS: string; Version: number };

beforeEach(() => {
  jest.clearAllMocks();
  setEnabled(true); // master switch defaults ON, reset per test
  rnPlatform.OS = 'ios';
  rnPlatform.Version = 0;
});

describe('master toggle', () => {
  it('defaults ON', () => {
    expect(isHapticsEnabled()).toBe(true);
  });

  it('setEnabled(false) silences every helper', async () => {
    setEnabled(false);
    haptics.tap();
    haptics.success();
    haptics.error();
    await flush();
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
    expect(Haptics.performAndroidHapticsAsync).not.toHaveBeenCalled();
  });

  it('setEnabled(true) restores haptics', async () => {
    setEnabled(false);
    setEnabled(true);
    haptics.tap();
    await flush();
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
  });

  it('exposes the persisted KV key', () => {
    expect(HAPTICS_KV_KEY).toBe('app_haptics_enabled');
  });
});

describe('iOS routing', () => {
  beforeEach(() => { rnPlatform.OS = 'ios'; });

  it('tap → impactAsync(Light)', async () => {
    haptics.tap();
    await flush();
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
    expect(Haptics.performAndroidHapticsAsync).not.toHaveBeenCalled();
  });

  it('select → selectionAsync', async () => {
    haptics.select();
    await flush();
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.performAndroidHapticsAsync).not.toHaveBeenCalled();
  });

  it('toggle(on) → selectionAsync', async () => {
    haptics.toggle(true);
    await flush();
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });

  it('longPress → impactAsync(Medium)', async () => {
    haptics.longPress();
    await flush();
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
  });

  it('success → notificationAsync(Success)', async () => {
    haptics.success();
    await flush();
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
  });

  it('warning → notificationAsync(Warning)', async () => {
    haptics.warning();
    await flush();
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Warning);
  });

  it('error → notificationAsync(Error)', async () => {
    haptics.error();
    await flush();
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Error);
  });

  it('destructive → notificationAsync(Error)', async () => {
    haptics.destructive();
    await flush();
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Error);
  });
});

describe('Android routing + API-level fallbacks', () => {
  beforeEach(() => { rnPlatform.OS = 'android'; });

  it('tap → performAndroidHapticsAsync(Virtual_Key)', async () => {
    haptics.tap();
    await flush();
    expect(Haptics.performAndroidHapticsAsync).toHaveBeenCalledWith(Haptics.AndroidHaptics.Virtual_Key);
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
  });

  describe('select (SEGMENT_TICK added API 34)', () => {
    it('API 34+ → Segment_Tick', async () => {
      rnPlatform.Version = 34;
      haptics.select();
      await flush();
      expect(Haptics.performAndroidHapticsAsync).toHaveBeenCalledWith(Haptics.AndroidHaptics.Segment_Tick);
    });

    it('API <34 → Clock_Tick fallback', async () => {
      rnPlatform.Version = 30;
      haptics.select();
      await flush();
      expect(Haptics.performAndroidHapticsAsync).toHaveBeenCalledWith(Haptics.AndroidHaptics.Clock_Tick);
    });
  });

  describe('success (CONFIRM added API 30)', () => {
    it('API 30+ → Confirm', async () => {
      rnPlatform.Version = 30;
      haptics.success();
      await flush();
      expect(Haptics.performAndroidHapticsAsync).toHaveBeenCalledWith(Haptics.AndroidHaptics.Confirm);
    });

    it('API <30 → Virtual_Key fallback', async () => {
      rnPlatform.Version = 29;
      haptics.success();
      await flush();
      expect(Haptics.performAndroidHapticsAsync).toHaveBeenCalledWith(Haptics.AndroidHaptics.Virtual_Key);
    });
  });

  describe('error/destructive (REJECT added API 30)', () => {
    it('API 30+ → Reject', async () => {
      rnPlatform.Version = 30;
      haptics.error();
      await flush();
      expect(Haptics.performAndroidHapticsAsync).toHaveBeenCalledWith(Haptics.AndroidHaptics.Reject);
    });

    it('API <30 → Long_Press fallback', async () => {
      rnPlatform.Version = 28;
      haptics.destructive();
      await flush();
      expect(Haptics.performAndroidHapticsAsync).toHaveBeenCalledWith(Haptics.AndroidHaptics.Long_Press);
    });
  });

  describe('toggle (TOGGLE added API 34)', () => {
    it('API 34+ on → Toggle_On', async () => {
      rnPlatform.Version = 34;
      haptics.toggle(true);
      await flush();
      expect(Haptics.performAndroidHapticsAsync).toHaveBeenCalledWith(Haptics.AndroidHaptics.Toggle_On);
    });

    it('API 34+ off → Toggle_Off', async () => {
      rnPlatform.Version = 34;
      haptics.toggle(false);
      await flush();
      expect(Haptics.performAndroidHapticsAsync).toHaveBeenCalledWith(Haptics.AndroidHaptics.Toggle_Off);
    });

    it('API <34 → Virtual_Key fallback', async () => {
      rnPlatform.Version = 33;
      haptics.toggle(true);
      await flush();
      expect(Haptics.performAndroidHapticsAsync).toHaveBeenCalledWith(Haptics.AndroidHaptics.Virtual_Key);
    });
  });
});

describe('throttledSelect (rapid-tap collapse)', () => {
  // The module keeps `lastSelectAt` as module-level state, which would leak
  // between tests (the first test stamps a real ~1.7e12 timestamp; later
  // mocked Date.now() values of ~1e6 are smaller and get collapsed as
  // "within the window"). Re-import fresh copies so each test starts clean.
  let h: typeof Haptics;
  let mod: typeof import('@/lib/haptics');

  beforeEach(() => {
    jest.resetModules();
    h = require('expo-haptics');
    mod = require('@/lib/haptics');
  });

  it('fires the first tap immediately', async () => {
    mod.haptics.throttledSelect();
    await flush();
    expect(h.selectionAsync).toHaveBeenCalledTimes(1);
  });

  it('collapses taps within the 900ms window', async () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    mod.haptics.throttledSelect();
    await flush();
    // Advance < window and tap repeatedly
    spy.mockReturnValue(1_000_400);
    mod.haptics.throttledSelect();
    spy.mockReturnValue(1_000_800);
    mod.haptics.throttledSelect();
    await flush();
    expect(h.selectionAsync).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('fires again after the window elapses', async () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    mod.haptics.throttledSelect();
    await flush();
    spy.mockReturnValue(1_000_950); // past SELECT_THROTTLE_MS
    mod.haptics.throttledSelect();
    await flush();
    expect(h.selectionAsync).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('respects the master toggle (no haptic, but no throw)', async () => {
    mod.setEnabled(false);
    expect(() => mod.haptics.throttledSelect()).not.toThrow();
    await flush();
    expect(h.selectionAsync).not.toHaveBeenCalled();
  });
});

describe('fire-and-forget contract', () => {
  it('every helper returns undefined (no promise leaks)', () => {
    expect(haptics.tap()).toBeUndefined();
    expect(haptics.select()).toBeUndefined();
    expect(haptics.throttledSelect()).toBeUndefined();
    expect(haptics.toggle(true)).toBeUndefined();
    expect(haptics.longPress()).toBeUndefined();
    expect(haptics.success()).toBeUndefined();
    expect(haptics.warning()).toBeUndefined();
    expect(haptics.error()).toBeUndefined();
    expect(haptics.destructive()).toBeUndefined();
  });

  it('swallows a rejecting primitive without throwing', async () => {
    (Haptics.impactAsync as jest.Mock).mockRejectedValueOnce(new Error('Vibration unavailable'));
    expect(() => haptics.tap()).not.toThrow();
    await flush();
  });

  it('swallows a rejecting Android primitive without throwing', async () => {
    rnPlatform.OS = 'android';
    (Haptics.performAndroidHapticsAsync as jest.Mock).mockRejectedValueOnce(new Error('Vibration unavailable'));
    expect(() => haptics.success()).not.toThrow();
    await flush();
  });
});
