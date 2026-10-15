import { create } from 'zustand';

// THE toast for the whole app: a compact floating pill (components/ui/Toast.tsx renders it). One store, a small
// stack — a second toast never replaces the first. Replaces the old full-width AppToast banner AND the separate
// SaveConfirmation banner (its "Annuler" undo is now just an `action`).
//
// Motion contract (modeled on the Muse.ai "Copied to clipboard" pill):
// - A repeat of the same plain toast COALESCEs into the pill already on screen: same slot, display clock
//   restarted, no tower of identical pills. A toast carrying an action ("Annuler") never coalesces and is
//   never coalesced into — an undo must stay fully visible for its whole window.
// - Dismissal is two-step: `dismiss` flags the pill `exiting` (the component fades/slides it out over
//   TOAST_EXIT_MS), then `remove` takes it out of the list. Nothing pops out of existence.

export type ToastTone = 'success' | 'warning' | 'info';

export const TOAST_DURATION_MS = 4000;     // plain toast
export const TOAST_ACTION_WINDOW_MS = 5000; // how long an "Annuler" stays available
export const TOAST_EXIT_MS = 190;           // fade/slide-out before the pill leaves the list
export const MAX_VISIBLE_TOASTS = 3;

export interface ToastAction { label: string; run: () => Promise<void> | void; windowMs?: number }

export interface ToastSpec {
  message: string;
  tone?: ToastTone;
  /** One quick action (e.g. "Annuler"). While it is available the pill stays up for `windowMs`. */
  action?: ToastAction;
  /** Shown after the action window closes, until the pill goes away (e.g. "Modifier"). */
  followUp?: { label: string; run: () => void };
  durationMs?: number;
}

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
  followUp?: { label: string; run: () => void };
  /** true once the action window has closed. */
  actionExpired: boolean;
  /** an action is running (undo in flight). */
  busy: boolean;
  /** dismissal has started: the component is animating the pill out; `remove` follows after TOAST_EXIT_MS. */
  exiting: boolean;
  /** how many times this exact plain toast was pushed while the pill was up (1 = first push). */
  repeats: number;
}

interface ToastStore {
  toasts: ToastItem[];
  push: (spec: ToastSpec) => number;
  /** Start the exit: flag the pill exiting; the store removes it after TOAST_EXIT_MS. */
  dismiss: (id: number) => void;
  /** Take the pill out of the list at once (exit finished, or a hard clear). */
  remove: (id: number) => void;
  runAction: (id: number) => Promise<void>;
  /** @deprecated compat for `useToastStore.getState().show(msg, tone)` — prefer `toast.*`. */
  show: (message: string, tone?: ToastTone) => void;
  clear: () => void;
}

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>[]>();
const clearTimers = (id: number) => { (timers.get(id) ?? []).forEach(clearTimeout); timers.delete(id); };

export const useToastStore = create<ToastStore>((set, get) => {
  // The dismissal clocks for one pill: plain toasts leave after their duration; an action toast leaves when
  // its window closes (a follow-up first gets a normal display time of its own).
  const schedule = (id: number, spec: ToastSpec) => {
    const total = spec.durationMs ?? TOAST_DURATION_MS;
    const handles: ReturnType<typeof setTimeout>[] = [];
    if (spec.action) {
      const windowMs = spec.action.windowMs ?? TOAST_ACTION_WINDOW_MS;
      handles.push(setTimeout(() => {
        set(s => ({ toasts: s.toasts.map(t => (t.id === id ? { ...t, actionExpired: true } : t)) }));
        // After the window: a follow-up gets a normal display time, otherwise the pill just goes.
        if (spec.followUp) timers.set(id, [setTimeout(() => get().dismiss(id), TOAST_DURATION_MS)]);
        else get().dismiss(id);
      }, windowMs));
    } else {
      handles.push(setTimeout(() => get().dismiss(id), total));
    }
    timers.set(id, handles);
  };

  return {
    toasts: [],

    push: (spec) => {
      const tone = spec.tone ?? 'success';
      // Coalesce a repeat: the same plain toast is already up — keep that one pill, bump its repeat count,
      // and restart its display clock instead of stacking a second identical pill beside it.
      if (!spec.action && !spec.followUp) {
        const existing = get().toasts.find(t => t.message === spec.message && t.tone === tone && !t.action && !t.followUp && !t.busy && !t.exiting);
        if (existing) {
          clearTimers(existing.id);
          set(s => ({ toasts: s.toasts.map(t => (t.id === existing.id ? { ...t, repeats: t.repeats + 1 } : t)) }));
          schedule(existing.id, spec);
          return existing.id;
        }
      }
      const id = nextId++;
      const item: ToastItem = {
        id, message: spec.message, tone,
        action: spec.action, followUp: spec.followUp, actionExpired: false, busy: false, exiting: false, repeats: 1,
      };
      set(s => {
        const next = [...s.toasts, item];
        // Over the cap: drop the oldest plain toast first; never silently drop one carrying an undo.
        while (next.length > MAX_VISIBLE_TOASTS) {
          const victim = next.findIndex(t => !t.action || t.actionExpired);
          const drop = victim === -1 ? 0 : victim;
          clearTimers(next[drop].id);
          next.splice(drop, 1);
        }
        return { toasts: next };
      });
      schedule(id, spec);
      return id;
    },

    dismiss: (id) => {
      const t = get().toasts.find(x => x.id === id);
      if (!t || t.exiting) return;
      clearTimers(id);
      set(s => ({ toasts: s.toasts.map(x => (x.id === id ? { ...x, exiting: true } : x)) }));
      timers.set(id, [setTimeout(() => get().remove(id), TOAST_EXIT_MS)]);
    },

    remove: (id) => {
      clearTimers(id);
      set(s => ({ toasts: s.toasts.filter(t => t.id !== id) }));
    },

    runAction: async (id) => {
      const t = get().toasts.find(x => x.id === id);
      if (!t?.action || t.busy || t.actionExpired) return;
      clearTimers(id);
      set(s => ({ toasts: s.toasts.map(x => (x.id === id ? { ...x, busy: true } : x)) }));
      try { await t.action.run(); } finally { get().dismiss(id); }
    },

    show: (message, tone = 'success') => { get().push({ message, tone }); },

    clear: () => { for (const t of get().toasts) clearTimers(t.id); set({ toasts: [] }); },
  };
});

export const toast = {
  success: (msg: string) => useToastStore.getState().push({ message: msg, tone: 'success' }),
  warning: (msg: string) => useToastStore.getState().push({ message: msg, tone: 'warning' }),
  info:    (msg: string) => useToastStore.getState().push({ message: msg, tone: 'info' }),
  /** Post-save confirmation: the saved result in words + an optional "Annuler" (real compensating action) and "Modifier" hand-off. */
  saved:   (o: { message: string; undo?: () => Promise<void> | void; onEdit?: () => void }) => useToastStore.getState().push({
    message: o.message, tone: 'success',
    action: o.undo ? { label: 'Annuler', run: o.undo } : undefined,
    followUp: o.onEdit ? { label: 'Modifier', run: o.onEdit } : undefined,
  }),
  /** Full form: tone, an "Annuler"-style action, a follow-up, a custom duration. */
  show:    (spec: ToastSpec) => useToastStore.getState().push(spec),
};

