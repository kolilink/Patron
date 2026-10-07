import { create } from 'zustand';

export interface AppAlertButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void | Promise<void>;
}

export interface AppAlertRequest {
  id: number;
  title: string;
  message?: string;
  buttons: AppAlertButton[];
}

interface AlertStore {
  current: AppAlertRequest | null;
  /** Mounted hosts, last = topmost (a native Modal window covers everything below it). */
  hosts: string[];
  registerHost: (id: string) => void;
  unregisterHost: (id: string) => void;
  dismiss: () => void;
}

let seq = 0;

export const useAlertStore = create<AlertStore>((set) => ({
  current: null,
  hosts: [],
  registerHost: (id) => set(s => (s.hosts.includes(id) ? s : { hosts: [...s.hosts, id] })),
  unregisterHost: (id) => set(s => ({ hosts: s.hosts.filter(h => h !== id) })),
  dismiss: () => set({ current: null }),
}));

/**
 * Drop-in replacement for Alert.alert(title, message?, buttons?): the app's own
 * ConfirmSheet on both platforms (theme-aware, no OS dialog). Alert.alert is
 * banned in user flows by the `no-system-alert` lint (scripts/lib/consistency-checks.js).
 */
export function appAlert(title: string, message?: string, buttons?: AppAlertButton[]): void {
  useAlertStore.setState({
    current: {
      id: ++seq,
      title,
      message,
      buttons: buttons && buttons.length > 0 ? buttons : [{ text: 'OK' }],
    },
  });
}
