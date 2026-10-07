// THE SEAM: anything that differs between offline and online reads ONE source of
// truth, never shifts layout, and degrades gracefully. Guards for the six instances.
import fs from 'fs';
import path from 'path';
import {
  recordCacheWriteFailure, recordCacheWriteSuccess, useCacheHealthStore, failingCacheTables, setCacheFailureReporter,
} from '@/lib/cacheHealth';
import { warmupTargetsFor } from '@/src/utils/cacheWarmupTargets';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('1. top inset — one source of truth', () => {
  it('Screen reads the line\'s published visibility, never sync counts', () => {
    const screen = read('src/components/ui/Screen.tsx');
    expect(screen).toMatch(/useSyncLineVisible\(\)/);
    expect(screen).not.toMatch(/pendingCount/);
  });
});

describe('2. the offline notice never takes layout space', () => {
  it('OfflineNotice renders nothing; the indicator is an absolute, touch-through overlay', () => {
    expect(read('src/components/ui/OfflineNotice.tsx')).toMatch(/return null;/);
    const ind = read('src/components/ui/OfflineIndicator.tsx');
    expect(ind).toMatch(/position: 'absolute'/);
    expect(ind).toMatch(/pointerEvents="none"/);
  });
});

describe('3. caches are warmed at startup, not per tab', () => {
  it('asks only for what the role may read (never an RLS-refused fetch)', () => {
    expect(warmupTargetsFor('administrateur')).toEqual({ fournisseurs: true, expenses: true });
    expect(warmupTargetsFor('manager')).toEqual({ fournisseurs: true, expenses: true });
    expect(warmupTargetsFor('vendeur')).toEqual({ fournisseurs: false, expenses: false });
    expect(warmupTargetsFor('investisseur')).toEqual({ fournisseurs: false, expenses: true });
  });
  it('the app layout runs the warmup behind the first paint, and again on reconnect', () => {
    const layout = read('app/(app)/_layout.tsx');
    expect(layout).toMatch(/warmCaches\(\)/);
    expect(layout).toMatch(/InteractionManager\.runAfterInteractions/);
    expect(layout).toMatch(/\[session\?\.activeBusiness\?\.id, session\?\.user\.id, reconnectTick\]/);
  });
  it('warms products, sales, suppliers, orders and expenses', () => {
    const src = read('src/utils/cacheWarmup.ts');
    for (const name of ["'products'", "'ventes'", "'fournisseurs'", "'commandes'", "'expenses'"]) expect(src).toContain(name);
  });
});

describe('4. cache-write failures are never silent', () => {
  beforeEach(() => { useCacheHealthStore.setState({ failures: {} }); setCacheFailureReporter(null); });

  it('a failed write is counted, flagged per table, and reported', () => {
    const reported: string[] = [];
    setCacheFailureReporter(t => reported.push(t));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    recordCacheWriteFailure('product_cache', new Error('disk full'));
    recordCacheWriteFailure('product_cache', new Error('disk full'));
    recordCacheWriteFailure('expense_cache', 'boom');
    spy.mockRestore();
    const f = useCacheHealthStore.getState().failures;
    expect(f.product_cache.count).toBe(2);
    expect(failingCacheTables(f)).toEqual(['expense_cache', 'product_cache']);
    expect(reported).toEqual(['product_cache', 'product_cache', 'expense_cache']);
  });

  it('a later successful write clears that table (the flag means "failing NOW")', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    recordCacheWriteFailure('product_cache', new Error('x'));
    spy.mockRestore();
    recordCacheWriteSuccess('product_cache');
    expect(failingCacheTables(useCacheHealthStore.getState().failures)).toEqual([]);
  });

  it('a reporter that throws can never break a cache write', () => {
    setCacheFailureReporter(() => { throw new Error('reporter down'); });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => recordCacheWriteFailure('t', new Error('x'))).not.toThrow();
    spy.mockRestore();
  });

  it('the single db write path records failures and successes, and Paramètres shows the flag', () => {
    const db = read('lib/db.ts');
    expect(db).toMatch(/recordCacheWriteFailure\(table, err\);\s*\n\s*throw err;/);
    expect(db).toMatch(/recordCacheWriteSuccess\(table\)/);
    expect(read('app/(app)/parametres/index.tsx')).toMatch(/Sauvegarde hors ligne en échec/);
    expect(read('app/_layout.tsx')).toMatch(/setCacheFailureReporter\(/);
  });
});

describe('5. a FAB never sits beside an empty state\'s own actions', () => {
  it('Vendre has no FAB at all any more (its offline-empty FAB collided with the empty state)', () => {
    const v = read('app/(app)/(tabs)/vendre.tsx');
    expect(v).not.toMatch(/AnimatedFAB/);
    expect(v).not.toMatch(/styles\.fabContainer/);
  });
  it('Fournisseurs / Ventes / Clients / Catalogue / Dépenses show their FAB only with data', () => {
    expect(read('app/(app)/fournisseurs/index.tsx')).toMatch(/\{fournisseurs\.length > 0 && \(\s*\n\s*<View style=\{styles\.fabContainer\}>/);
    expect(read('app/(app)/ventes/index.tsx')).toMatch(/canSell && !selected && sales\.length > 0/);
    expect(read('app/(app)/clients/index.tsx')).toMatch(/allClients\.length > 0 && !isInvestisseur/);
    expect(read('app/(app)/(tabs)/catalogue.tsx')).toMatch(/tab === 'actifs' && products\.length > 0/);
    expect(read('app/(app)/depenses/index.tsx')).toMatch(/\{!isEmpty && \(/);
  });
  it('the empty states that lost a FAB still offer the action', () => {
    expect(read('app/(app)/fournisseurs/index.tsx')).toMatch(/linkLabel="Nouvelle livraison"/);
    expect(read('app/(app)/(tabs)/vendre.tsx')).toMatch(/linkLabel=\{offline && !isVendeur \? 'Ajouter un produit'/);
  });
});

describe('6. every scene is explicitly opaque', () => {
  it('Screen, the tab scenes and every navigator card carry the theme background', () => {
    expect(read('src/components/ui/Screen.tsx')).toMatch(/backgroundColor: palette\.background/);
    expect(read('app/(app)/(tabs)/_layout.tsx')).toMatch(/sceneStyle: \{ backgroundColor: palette\.background \}/);
    expect(read('src/components/ui/ThemedStack.tsx')).toMatch(/contentStyle: \{ backgroundColor: palette\.background \}/);
    for (const f of ['app/_layout.tsx', 'app/(app)/_layout.tsx', 'app/(welcome)/_layout.tsx', 'app/(auth)/_layout.tsx']) {
      expect(read(f)).toMatch(/Themed(Stack|RootView)/);
    }
  });
});
