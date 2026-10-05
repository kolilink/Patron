// Which rows were just removed by a user action that can be undone. A row that
// comes back within the window (Annuler on an archive) fades in; every other
// row appearing — first paint, scroll remount, refetch — appears instantly, so
// nothing animates on mount.
const UNDO_WINDOW_MS = 12_000;
const removed = new Map<string, number>();

export function markRowRemoved(id: string, now: number = Date.now()): void {
  removed.set(id, now);
}

/** True once, if `id` was removed recently; consuming clears it. */
export function consumeRowRestored(id: string, now: number = Date.now()): boolean {
  const at = removed.get(id);
  if (at === undefined) return false;
  removed.delete(id);
  return now - at <= UNDO_WINDOW_MS;
}
