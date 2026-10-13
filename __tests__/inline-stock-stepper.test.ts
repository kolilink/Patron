// Inline stock stepper in "Modifier le produit": a +/- composes a delta on screen; Enregistrer records ONE relative,
// idempotent movement. No second sheet, no silent absolute rewrite.
import fs from 'fs';
import path from 'path';
import { stepStock, isStockDirty, stockDelta, isEditDirty, editingToState, EMPTY_QUICK_ADD } from '@/src/utils/quickAddProduct';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const product: any = { id: 'p1', name: 'Riz', sale_price: 2000, cost_price: 1500, stock_qty: 12, reorder_level: 0, unit: 'pcs', has_variants: false, supplier_id: null };
const saved = editingToState(product, [], 'GNF');

describe('stepper arithmetic', () => {
  it('+ and − move the displayed value by one; it can never go below 0', () => {
    expect(stepStock('12', 1)).toBe('13');
    expect(stepStock('12', -1)).toBe('11');
    expect(stepStock('0', -1)).toBe('0');
    expect(stepStock('', 1)).toBe('1');
    expect(stepStock('', -1)).toBe('0');
    expect(stepStock('abc', 1)).toBe('1');
  });
  it('seeded from the stored stock', () => { expect(saved.qty).toBe('12'); });
});

describe('the yellow dot: stock differs from what the sheet opened with', () => {
  it('clean → no dot; moved → dot; tapped back to the original → dot gone', () => {
    expect(isStockDirty(saved, saved)).toBe(false);
    const up = { ...saved, qty: stepStock(saved.qty, 1) };
    expect(isStockDirty(up, saved)).toBe(true);
    const back = { ...up, qty: stepStock(up.qty, -1) };
    expect(isStockDirty(back, saved)).toBe(false);
  });
  it('name/price edits do not trigger it (stock-scoped only) — but they still make the sheet dirty for drafts', () => {
    const renamed = { ...saved, name: 'Riz 5kg' };
    expect(isStockDirty(renamed, saved)).toBe(false);
    expect(isEditDirty(renamed, saved)).toBe(true);
  });
  it('a stock tweak alone counts as a draft-worthy edit', () => {
    expect(isEditDirty({ ...saved, qty: '13' }, saved)).toBe(true);
  });
  it('models on: the stepper is not in play (no stock dot)', () => {
    expect(isStockDirty({ ...saved, models: true, qty: '99' }, { ...saved, models: true })).toBe(false);
  });
});

describe('save = one relative movement, never an absolute rewrite', () => {
  it('delta is the on-screen stock minus the stored stock; the direction is derived', () => {
    expect(stockDelta(15, 12)).toBe(3);    // entrée 3
    expect(stockDelta(9, 12)).toBe(-3);    // perte 3
    expect(stockDelta(12, 12)).toBe(0);    // nothing recorded
    expect(stockDelta(undefined, 12)).toBe(0); // untouched stock → no payload field → no phantom movement
  });
  const hook = read('src/components/products/useProductSheets.tsx');
  const sheet = read('src/components/QuickAddProductSheet.tsx');
  const store = read('stores/products.ts');
  it('handleEdit records the movement through the existing adjustStock pipeline with the derived direction', () => {
    expect(hook).toContain("const delta = stockDelta(stockQty, editTarget.stock_qty);");
    expect(hook).toContain("Math.abs(delta), delta > 0 ? 'entree' : 'perte', ''");
  });
  it('updateProduct never carries stock; the absolute is only a transient payload field', () => {
    const start = store.indexOf('updateProduct: async');
    const upd = store.slice(start, Math.min(...['archiveProduct: async', 'adjustStock: async', 'fetchVariants: async'].map(m => store.indexOf(m, start)).filter(i => i > 0)));
    expect(upd).not.toMatch(/stock_qty|stockQty/);
    expect(sheet).toContain('payload.stockQty = parseInt(s.qty, 10) || 0');
    expect(sheet).toMatch(/if \(isEdit && editing && !s\.models && stockDirty\) payload\.stockQty/); // only when the stepper moved it
  });
  it('if the movement fails after the product saved: warning toast, sheet stays open, no success toast', () => {
    const edit = hook.slice(hook.indexOf('const delta = stockDelta'), hook.indexOf("toast.success('Produit mis à jour ✓')"));
    expect(edit).toMatch(/if \(!stockOk\) \{[\s\S]*?haptics\.error\(\);[\s\S]*?toast\.warning\([\s\S]*?return \{ ok: false \};/);
  });
});

describe('UI wiring', () => {
  const sheet = read('src/components/QuickAddProductSheet.tsx');
  it('+ on top, − below, labelled, ≥44dp, taps only change local state (no write/sheet/navigation)', () => {
    const row = sheet.slice(sheet.indexOf('accessibilityLabel="Augmenter le stock"') - 400, sheet.indexOf('accessibilityLabel="Diminuer le stock"') + 300);
    expect(row.indexOf('Augmenter le stock')).toBeLessThan(row.indexOf('Diminuer le stock'));
    expect(row).toContain('stepStock(prev.qty, 1)');
    expect(row).toContain('stepStock(prev.qty, -1)');
    expect(row).toContain('haptics.throttledSelect()');
    expect(sheet).toMatch(/stockStepBtn: \{ width: 48, height: 44/);
  });
  it('the dot rides the Button icon slot: only in edit, only when dirty, never while saving, labelled', () => {
    expect(sheet).toContain('icon={isEdit && stockDirty && !saving ?');
    expect(sheet).toContain('accessibilityLabel="Modifications non enregistrées"');
    expect(sheet).toContain('backgroundColor: palette.warning');
  });
  it('the old "Ajuster le stock" sheet is completely gone', () => {
    const walk = (d: string, out: string[] = []): string[] => { for (const e of fs.readdirSync(path.join(__dirname, '..', d), { withFileTypes: true })) { const r = `${d}/${e.name}`; if (e.isDirectory()) walk(r, out); else if (/\.tsx?$/.test(e.name)) out.push(r); } return out; };
    const hits = ['src', 'app'].flatMap(d => walk(d)).filter(f => /StockAdjustModal|onAdjust|openAdjust|handleAdjust/.test(read(f)));
    expect(hits).toEqual([]);
    expect(sheet).not.toMatch(/>Ajuster</);
  });
});
void EMPTY_QUICK_ADD;
