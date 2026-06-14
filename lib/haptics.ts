import * as Haptics from 'expo-haptics';

// Fire-and-forget — callers never await.
// try/catch guards against broken vibration motors on cheap Android hardware.
export const haptics = {
  // Light tap — picking something up, toggling, liking
  tap: () => {
    void (async () => { try { await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {} })();
  },
  // Single heavy thud — reserved for sale completion only
  heavy: () => {
    void (async () => { try { await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); } catch {} })();
  },
  // Crisp click — accordion open/close, selection changes
  selection: () => {
    void (async () => { try { await Haptics.selectionAsync(); } catch {} })();
  },
  // Triple success pulse — confirmations, saves
  success: () => {
    void (async () => { try { await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {} })();
  },
  // Warning pulse — last unit in stock
  warning: () => {
    void (async () => { try { await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch {} })();
  },
  // Error pulse — failures, destructive actions
  error: () => {
    void (async () => { try { await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); } catch {} })();
  },
};
