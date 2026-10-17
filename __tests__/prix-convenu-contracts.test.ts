// Prix convenu representation (v246) — source contracts.
// The behaviour itself is unit-tested (buildCartJson, saleReceipt,
// pendingOverlay) and integration-tested (submit_sale persists the
// column, reconciliation check #9 tolerance). These pins keep the
// visible markers and the migration from silently disappearing.
import * as fs from 'fs';
import * as path from 'path';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('prix convenu — representation contracts', () => {
  it('the sale detail marks an agreed line, in the vendor’s words', () => {
    const src = read('app/(app)/ventes/index.tsx');
    expect(src).toContain('Prix convenu');
    expect(src).toContain('catalog_unit_price');
    expect(src).toContain('au lieu de');
  });

  it('the receipt view adds « · convenu » to a flagged line', () => {
    expect(read('src/components/DebtReminderReceipt.tsx')).toContain('· convenu');
    expect(read('src/utils/saleReceipt.ts')).toContain('catalogUnitPrice');
  });

  it('migration v246 stores the snapshot and tolerates rounding in check #9', () => {
    const mig = read('db/migration_v246.sql');
    expect(mig).toContain('ADD COLUMN IF NOT EXISTS catalog_unit_price');
    expect(mig).toContain("nullif(v_item->>'catalog_unit_price', '')::numeric");
    expect(mig).toContain('ABS(so.total_amount - COALESCE(ls.total, 0)) > 2');
    // Superset discipline: the v245 stock flag survives, and the
    // reconciliation body is the LATEST one (v235 — expenses_visible
    // reads), not the v187 original the check numbers came from.
    expect(mig).toContain('needs_stock_review');
    expect(mig).toContain('CREATE OR REPLACE FUNCTION public.submit_sale(');
    expect(mig).toContain('CREATE OR REPLACE FUNCTION public.run_reconciliation()');
    expect(mig).toContain('expenses_visible');
  });
});
