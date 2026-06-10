import * as Haptics from 'expo-haptics';

// Fire-and-forget — callers never await.
// try/catch guards against broken vibration motors on cheap Android hardware.
export const haptics = {
  tap: () => {
    void (async () => { try { await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {} })();
  },
  success: () => {
    void (async () => {
      try { await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
    })();
  },
  error: () => {
    void (async () => {
      try { await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); } catch {}
    })();
  },
};
