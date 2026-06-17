import { create } from 'zustand';

type ToastType = 'success' | 'warning' | 'info';

interface ToastStore {
  message: string | null;
  type: ToastType;
  show: (message: string, type?: ToastType) => void;
  hide: () => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  message: null,
  type: 'success',
  show: (message, type = 'success') => set({ message, type }),
  hide: () => set({ message: null }),
}));

export const toast = {
  success: (msg: string) => useToastStore.getState().show(msg, 'success'),
  warning: (msg: string) => useToastStore.getState().show(msg, 'warning'),
  info:    (msg: string) => useToastStore.getState().show(msg, 'info'),
};
