// §8 of the offline-first rewrite: computeSyncStatusLabel is
// SyncStatusLine's pure state-selection logic, extracted specifically so
// it's testable without a component-rendering setup (this codebase's own
// convention — see CLAUDE.md — is mocked-Supabase unit tests, not UI
// tests). Final spec: online renders nothing in the clean state (null,
// zero height); offline renders nothing from SyncStatusLine (null —
// OfflineNotice owns the single "Hors ligne"); only the syncing and 7-day
// escalation lines render while online.

import { computeSyncStatusLabel } from '@/src/components/ui/syncStatusLabel';

const NOW = new Date('2026-09-28T12:00:00.000Z').getTime();

describe('computeSyncStatusLabel', () => {
  it('returns null when nothing has ever synced and nothing is pending — no sync UI at all yet', () => {
    expect(computeSyncStatusLabel({ syncing: false, pendingCount: 0, lastSyncedAt: null, oldestQueuedAt: null, now: NOW })).toBeNull();
  });

  it('"Synchronisation…" while actively draining, regardless of pendingCount', () => {
    expect(computeSyncStatusLabel({ syncing: true, pendingCount: 3, lastSyncedAt: null, oldestQueuedAt: null, now: NOW }))
      .toBe('Synchronisation…');
  });

  it('clean state (online + fully synced) → null: no "Tout est synchronisé ✓", no timestamp', () => {
    const label = computeSyncStatusLabel({
      syncing: false, pendingCount: 0, lastSyncedAt: '2026-09-28T10:30:00.000Z', oldestQueuedAt: null, now: NOW,
    });
    expect(label).toBeNull();
  });

  it('offline with items waiting to sync → null: OfflineNotice owns the single "Hors ligne"', () => {
    const sixDaysAgo = new Date(NOW - 6 * 24 * 60 * 60 * 1000).toISOString();
    expect(computeSyncStatusLabel({ syncing: false, pendingCount: 4, lastSyncedAt: null, oldestQueuedAt: sixDaysAgo, now: NOW }))
      .toBeNull();
  });

  it('offline with empty queue → null: OfflineNotice still owns the single "Hors ligne"', () => {
    expect(computeSyncStatusLabel({ syncing: false, pendingCount: 0, lastSyncedAt: '2026-09-28T10:30:00.000Z', oldestQueuedAt: null, now: NOW }))
      .toBeNull();
  });

  it('pending, exactly at the 7-day boundary: escalates', () => {
    const exactlySevenDaysAgo = new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString();
    const label = computeSyncStatusLabel({ syncing: false, pendingCount: 1, lastSyncedAt: null, oldestQueuedAt: exactlySevenDaysAgo, now: NOW });
    expect(label).toBe('7 jours sans connexion — connectez-vous pour sauvegarder vos données.');
  });

  it('pending, just under 7 days: still offline-owned null, not the escalation', () => {
    const almostSevenDays = new Date(NOW - (7 * 24 * 60 * 60 * 1000 - 1000)).toISOString();
    const label = computeSyncStatusLabel({ syncing: false, pendingCount: 1, lastSyncedAt: null, oldestQueuedAt: almostSevenDays, now: NOW });
    expect(label).toBeNull();
  });

  it('pending with no known oldestQueuedAt yet (still resolving): offline-owned null, never crashes', () => {
    const label = computeSyncStatusLabel({ syncing: false, pendingCount: 2, lastSyncedAt: null, oldestQueuedAt: null, now: NOW });
    expect(label).toBeNull();
  });

  it('never mentions a raw pending count anywhere — the standing "zero sync noise" rule', () => {
    // pendingCount is deliberately a large, distinctive number in every
    // case — if it ever leaked into a label, it would show up verbatim.
    const cases = [
      { syncing: true, pendingCount: 4321, lastSyncedAt: null, oldestQueuedAt: null, now: NOW },
      { syncing: false, pendingCount: 4321, lastSyncedAt: null, oldestQueuedAt: new Date(NOW - 8 * 86400000).toISOString(), now: NOW },
      { syncing: false, pendingCount: 4321, lastSyncedAt: null, oldestQueuedAt: new Date(NOW - 1000).toISOString(), now: NOW },
    ];
    for (const c of cases) {
      const label = computeSyncStatusLabel(c);
      // Offline branches now return null (nothing renders) — trivially no
      // count leak. Only assert on the labels that actually render.
      if (label !== null) expect(label).not.toContain('4321');
    }
  });
});
