import { create } from 'zustand';

// Reusable post-save confirmation banner state — distinct from useToastStore
// (stores/toast.ts): a toast is fire-and-forget with no action, this banner
// carries an optional ~8s "Annuler" (undo) action and, once that window
// expires, an optional hand-off to the record's existing edit/correction
// screen instead of silently disappearing. See CLAUDE.md's "Keeping this
// file current" — this is intentionally a second, purpose-built mechanism
// rather than bolting an action button onto AppToast.

export const UNDO_WINDOW_MS = 8000;

type Tone = 'success' | 'settled';

interface SaveConfirmationState {
  visible: boolean;
  message: string;
  tone: Tone;
  expired: boolean;
  undo?: () => Promise<void> | void;
  onEdit?: () => void;
  undoing: boolean;

  show: (opts: {
    message: string;
    tone?: Tone;
    undo?: () => Promise<void> | void;
    onEdit?: () => void;
  }) => void;
  hide: () => void;
  expire: () => void;
  runUndo: () => Promise<void>;
}

export const useSaveConfirmationStore = create<SaveConfirmationState>((set, get) => ({
  visible: false,
  message: '',
  tone: 'success',
  expired: false,
  undo: undefined,
  onEdit: undefined,
  undoing: false,

  show: ({ message, tone = 'success', undo, onEdit }) => {
    set({ visible: true, message, tone, expired: false, undo, onEdit, undoing: false });
  },

  hide: () => set({ visible: false, undo: undefined, onEdit: undefined, undoing: false }),

  expire: () => set({ expired: true }),

  runUndo: async () => {
    const { undo } = get();
    if (!undo) return;
    set({ undoing: true });
    try {
      await undo();
    } finally {
      set({ visible: false, undo: undefined, onEdit: undefined, undoing: false });
    }
  },
}));
