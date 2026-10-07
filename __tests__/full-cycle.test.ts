// THE FULL CYCLE — the parts of the offline/online lifecycle that are checkable in code.
import fs from 'fs';
import path from 'path';
import { opBusinessId } from '@/lib/pendingOverlay';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('2. kill → reopen: pendingCount is known before the first paint', () => {
  it('the outbox count is read inside the db-open startup step (before the splash lifts)', () => {
    expect(read('app/_layout.tsx')).toMatch(/openDb\(\)\.then\(\(\) => useSyncStore\.getState\(\)\.refreshCount\(\)\)/);
  });
});

describe('4. a failed record is VISIBLE, whatever kind it is', () => {
  it('every queued operation kind has wording (no silent "Opération" for a known op)', () => {
    const src = read('lib/pendingOverlay.ts');
    for (const op of ['create_expense', 'approve_expense', 'reject_expense', 'create_product', 'update_product', 'adjust_stock_move', 'pay_supplier_debt', 'create_supplier_debt', 'submit_sale', 'record_client_payment']) {
      expect(src).toContain(`${op}:`);
    }
  });
  it('unreadable (corrupt) rows are surfaced too — Abandonner only, never a Réessayer that cannot work', () => {
    const src = read('lib/pendingOverlay.ts');
    expect(src).toMatch(/for \(const c of corrupt\)/);
    expect(src).toMatch(/retryable: false/);
    expect(read('src/components/RefusedOpsNotice.tsx')).toMatch(/op\.retryable && <Button label="Réessayer"/);
  });
  it('the notice is mounted on Accueil as well as Ventes and Rapports', () => {
    expect(read('app/(app)/(tabs)/index.tsx')).toMatch(/<RefusedOpsNotice \/>/);
    expect(read('app/(app)/ventes/index.tsx')).toMatch(/<RefusedOpsNotice \/>/);
    expect(read('app/(app)/rapports/index.tsx')).toMatch(/<RefusedOpsNotice \/>/);
  });
  it('finds the business of every payload shape (flat, p_-prefixed, nested product)', () => {
    expect(opBusinessId({ p_business_id: 'a' })).toBe('a');
    expect(opBusinessId({ business_id: 'b' })).toBe('b');
    expect(opBusinessId({ product: { business_id: 'c' } })).toBe('c');
    expect(opBusinessId({ id: 'x' })).toBeNull();
  });
});

describe('5. filtered views never silently omit a pending record', () => {
  it('status-filtered fetches (seed, offline fallback, live) all go through the outbox overlay', () => {
    const v = read('stores/ventes.ts');
    expect(v).toMatch(/async function overlayForStatus\(/);
    expect((v.match(/overlayForStatus\(/g) ?? []).length).toBeGreaterThanOrEqual(4); // def + 3 call sites
    expect(v).not.toMatch(/falls back to a cache-only seed, same as before/);
  });
});

describe('6. flapping', () => {
  it('the reconnect effect is driven by the settled reconnectTick, not by raw NetInfo events', () => {
    const l = read('app/(app)/_layout.tsx');
    expect(l).toMatch(/reconnectTick === 0\) return;/);
    expect(l).not.toMatch(/NetInfo\.addEventListener/);
  });
  it('the offline pill has hysteresis (appear after 500ms offline, vanish after 900ms online)', () => {
    expect(read('src/components/ui/OfflineIndicator.tsx')).toMatch(/rawOffline \? 500 : 900/);
  });
  it('the drainer does nothing while known-offline (no attempts burned, no duplicates)', () => {
    expect(read('lib/sync.ts')).toMatch(/if \(isKnownOffline\(\)\) return \{ synced: 0/);
  });
});
