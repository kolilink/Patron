// SINGLE SOURCE OF TRUTH for "is the sync status line actually occupying the top
// of the screen?". SyncStatusLine PUBLISHES it (its real, debounced, rendered
// state); Screen READS it to decide whether to keep its own top safe-area inset.
//
// Before this, Screen guessed from `pendingCount > 0` while SyncStatusLine's own
// label is null when offline with items waiting (OfflineNotice owns that state):
// the two disagreed, nothing consumed the status-bar inset, and the whole screen
// jumped under the clock the moment a credit was recorded offline. Screen must
// never infer this from sync counts again — only from this flag.
import { create } from 'zustand';

interface SyncLineVisibilityState {
  visible: boolean;
}

export const useSyncLineStore = create<SyncLineVisibilityState>(() => ({ visible: false }));

export function setSyncLineVisible(visible: boolean): void {
  if (useSyncLineStore.getState().visible !== visible) useSyncLineStore.setState({ visible });
}

/** True only while the sync line is truly rendering with height. */
export function useSyncLineVisible(): boolean {
  return useSyncLineStore(s => s.visible);
}
