// §8 of the offline-first rewrite: SyncStatusLine's pure state-selection
// logic, kept in its own plain .ts file (not inside SyncStatusLine.tsx)
// specifically so it's importable from a jest test — this repo's jest
// config has no JSX transform configured at all (no UI/component tests
// anywhere in this codebase, by long-standing convention, see CLAUDE.md),
// so a .tsx file containing real JSX cannot be imported from a test even
// just to reach one exported non-JSX function inside it. Confirmed by
// trying exactly that first and watching it fail with "Unexpected token
// '<'" on the component's own JSX, not assumed.
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function computeSyncStatusLabel(args: {
  syncing: boolean;
  pendingCount: number;
  lastSyncedAt: string | null;
  oldestQueuedAt: string | null;
  now?: number;
}): string | null {
  const { syncing, pendingCount, lastSyncedAt, oldestQueuedAt } = args;
  const now = args.now ?? Date.now();

  if (pendingCount === 0 && !lastSyncedAt) return null; // nothing has ever synced yet — nothing to say

  if (syncing) return 'Synchronisation…';

  if (pendingCount === 0) {
    const time = lastSyncedAt
      ? new Date(lastSyncedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      : '';
    return `Tout est synchronisé ✓${time ? ` · ${time}` : ''}`;
  }

  if (oldestQueuedAt && now - new Date(oldestQueuedAt).getTime() >= SEVEN_DAYS_MS) {
    return '7 jours sans connexion — connectez-vous pour sauvegarder vos données.';
  }

  return 'En attente de connexion — vos données sont en sécurité sur ce téléphone.';
}
