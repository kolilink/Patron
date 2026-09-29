import { create } from 'zustand';
import { getKV, setKV } from '@/lib/db';
import { getNotificationPermissionStatus } from '@/src/components/NotificationSetup';

// Local, per-device state for the permission-priming card — deliberately
// not synced anywhere server-side, this is purely "have we already shown
// this on this device." Shown at most twice ever, and only after a real
// value moment (first sale, first credit sale, or first product write),
// never at app open. See CLAUDE.md-style rationale in
// ActivationPrimingSheet.tsx.
const SHOWN_COUNT_KEY = 'activation_priming_shown_count';
const RESOLVED_KEY = 'activation_priming_resolved'; // set once the merchant taps "Continuer" — never ask again

interface ActivationPrimingStore {
  visible: boolean;
  hide: () => void;
  /** Call after a value moment completes. No-ops unless priming is actually due. */
  maybeTrigger: () => Promise<void>;
  /** Called when the merchant taps "Continuer". */
  markResolved: () => Promise<void>;
  /** Called when the merchant taps "Plus tard" — may reappear once more later. */
  markDismissed: () => Promise<void>;
}

async function getShownCount(): Promise<number> {
  const raw = await getKV(SHOWN_COUNT_KEY);
  return raw ? parseInt(raw, 10) || 0 : 0;
}

export const useActivationPrimingStore = create<ActivationPrimingStore>((set) => ({
  visible: false,

  hide: () => set({ visible: false }),

  maybeTrigger: async () => {
    try {
      const resolved = await getKV(RESOLVED_KEY);
      if (resolved) return;
      const shownCount = await getShownCount();
      if (shownCount >= 2) return;

      // Already granted or permanently denied — nothing this card can offer.
      const status = await getNotificationPermissionStatus();
      if (status !== 'undetermined') return;

      await setKV(SHOWN_COUNT_KEY, String(shownCount + 1));
      set({ visible: true });
    } catch {
      // Best-effort — never blocks the value-moment flow it's attached to
    }
  },

  markResolved: async () => {
    try { await setKV(RESOLVED_KEY, '1'); } catch { /* best-effort */ }
    set({ visible: false });
  },

  markDismissed: async () => {
    set({ visible: false });
  },
}));

export const activationPriming = {
  maybeTrigger: () => void useActivationPrimingStore.getState().maybeTrigger(),
};
