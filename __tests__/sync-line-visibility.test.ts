// Screen and SyncStatusLine must never disagree about the top inset: Screen reads
// the line's own published state — never a guess from pendingCount.
import fs from 'fs';
import path from 'path';
import { setSyncLineVisible, useSyncLineStore } from '@/src/components/ui/syncLineVisibility';
import { computeSyncStatusLabel } from '@/src/components/ui/syncStatusLabel';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('sync line visibility — single source of truth', () => {
  it('Screen reads the published flag and never infers it from sync counts', () => {
    const screen = read('src/components/ui/Screen.tsx');
    expect(screen).toMatch(/useSyncLineVisible\(\)/);
    expect(screen).not.toMatch(/pendingCount/);
    expect(screen).not.toMatch(/stores\/sync/);
  });

  it('SyncStatusLine publishes its real (debounced, measured) state and clears it on unmount', () => {
    const line = read('src/components/ui/SyncStatusLine.tsx');
    expect(line).toMatch(/setSyncLineVisible\(visible && barHeight > 0\)/);
    expect(line).toMatch(/useEffect\(\(\) => \(\) => setSyncLineVisible\(false\), \[\]\)/);
  });

  it('the flag toggles only on real changes', () => {
    useSyncLineStore.setState({ visible: false });
    setSyncLineVisible(true);
    expect(useSyncLineStore.getState().visible).toBe(true);
    setSyncLineVisible(false);
    expect(useSyncLineStore.getState().visible).toBe(false);
  });

  it('the regression case: offline with items waiting renders NO line — so the flag stays false and Screen keeps its inset', () => {
    // pendingCount > 0 used to make Screen drop its inset even though the label is null here
    expect(computeSyncStatusLabel({ syncing: false, pendingCount: 3, lastSyncedAt: '2026-10-07T00:00:00Z', oldestQueuedAt: new Date().toISOString() })).toBeNull();
  });
});
