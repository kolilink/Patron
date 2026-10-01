import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

// ---------------------------------------------------------------------------
// Semantic haptics — Patron
//
// Callers express INTENT (tap, select, success…), never a waveform. Platform
// branching lives entirely in this file:
//   • iOS        → impactAsync / selectionAsync / notificationAsync
//   • Android    → performAndroidHapticsAsync(AndroidHaptics.*) — the modern
//                  primitive that does NOT require the VIBRATE permission
//                  (unlike the raw Vibrator API, which is never used here).
//
// Android API-level fallbacks (§5d): CONFIRM/REJECT were added to Android's
// HapticFeedbackConstants at API 30 and SEGMENT_TICK/TOGGLE at API 34. Below
// those we fall back to universally-available effects (Virtual_Key 21+,
// Clock_Tick 21+, Long_Press 21+) so cheap motors on Tecno/Infinix/Itel never
// blur queued pulses into a continuous buzz (cancel-not-queue).
//
// Fire-and-forget: helpers never return a promise, never block the UI, and
// swallow broken-motor failures silently.
// ---------------------------------------------------------------------------

// Persisted master-switch key (read at startup by app/_layout.tsx, toggled in
// parametres/index.tsx).
export const HAPTICS_KV_KEY = 'app_haptics_enabled';

// Master switch — default ON. The single chokepoint every helper routes
// through; flipping it off silences every haptic in the app at once.
let enabled = true;
export function setEnabled(value: boolean): void {
  enabled = value;
}
export function isHapticsEnabled(): boolean {
  return enabled;
}

// Rapid-tap window (§5d: 800–1000 ms). First tap haptics, the rest are
// visual-only — used in the Vendre rush flow where qty +/− and add-to-cart
// taps land in quick succession.
const SELECT_THROTTLE_MS = 900;
// -Infinity guarantees the very first tap always fires (0 would collide with
// epoch-0 in tests).
let lastSelectAt = -Infinity;

const { AndroidHaptics, ImpactFeedbackStyle, NotificationFeedbackType } = Haptics;

// Android API level — reads lazily so tests can flip Platform.OS/Version on
// the (mutable) react-native mock without re-importing this module.
function androidApiLevel(): number {
  if (Platform.OS !== 'android') return 0;
  const v = Number(Platform.Version);
  return Number.isFinite(v) ? v : 0;
}

// Fire-and-forget core: gate on the master switch, then run and swallow.
function fire(fn: () => Promise<void>): void {
  if (!enabled) return;
  void (async () => {
    try {
      await fn();
    } catch {
      // Broken vibration motor / "Vibration unavailable" — never crash, never
      // queue, never surface. The visual state always carries the meaning.
    }
  })();
}

// Android effect selection with API-level fallbacks.
function androidConfirm(): Haptics.AndroidHaptics {
  return androidApiLevel() >= 30 ? AndroidHaptics.Confirm : AndroidHaptics.Virtual_Key;
}
function androidReject(): Haptics.AndroidHaptics {
  return androidApiLevel() >= 30 ? AndroidHaptics.Reject : AndroidHaptics.Long_Press;
}
function androidTick(): Haptics.AndroidHaptics {
  return androidApiLevel() >= 34 ? AndroidHaptics.Segment_Tick : AndroidHaptics.Clock_Tick;
}
function androidToggle(on: boolean): Haptics.AndroidHaptics {
  return androidApiLevel() >= 34
    ? (on ? AndroidHaptics.Toggle_On : AndroidHaptics.Toggle_Off)
    : AndroidHaptics.Virtual_Key;
}

// Route one semantic intent to the right platform primitive.
function run(ios: () => Promise<void>, androidEffect: Haptics.AndroidHaptics): void {
  fire(() => (Platform.OS === 'android' ? Haptics.performAndroidHapticsAsync(androidEffect) : ios()));
}

export const haptics = {
  // Light pick-up / like / key tap.
  tap: () =>
    run(
      () => Haptics.impactAsync(ImpactFeedbackStyle.Light),
      AndroidHaptics.Virtual_Key,
    ),

  // Crisp selection change / accordion. Use throttledSelect() for rapid-tap
  // contexts (Vendre qty steppers, add-to-cart).
  select: () =>
    run(
      () => Haptics.selectionAsync(),
      androidTick(),
    ),

  // Rapid-tap guard: first tap fires, subsequent taps within the window are
  // visual-only (§5d). Never blocks the UI; just skips the haptic.
  throttledSelect: () => {
    if (!enabled) return;
    const now = Date.now();
    if (now - lastSelectAt < SELECT_THROTTLE_MS) return;
    lastSelectAt = now;
    haptics.select();
  },

  // Switch / checkbox state change.
  toggle: (on: boolean) =>
    run(
      () => Haptics.selectionAsync(),
      androidToggle(on),
    ),

  // Long press that performs an action.
  longPress: () =>
    run(
      () => Haptics.impactAsync(ImpactFeedbackStyle.Medium),
      AndroidHaptics.Long_Press,
    ),

  // Success — sale completed, saved, confirmed.
  success: () =>
    run(
      () => Haptics.notificationAsync(NotificationFeedbackType.Success),
      androidConfirm(),
    ),

  // Warning — last unit in stock, non-fatal heads-up. Android has no distinct
  // warning primitive; the visual state carries the distinction.
  warning: () =>
    run(
      () => Haptics.notificationAsync(NotificationFeedbackType.Warning),
      androidConfirm(),
    ),

  // Error — action failed.
  error: () =>
    run(
      () => Haptics.notificationAsync(NotificationFeedbackType.Error),
      androidReject(),
    ),

  // Destructive commit — delete / archive / revoke.
  destructive: () =>
    run(
      () => Haptics.notificationAsync(NotificationFeedbackType.Error),
      androidReject(),
    ),
};
