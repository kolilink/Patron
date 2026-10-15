// Contracts for the two bug classes Sebastiao caught live on 2026-10-15
// (after PR #146 fixed their first instances):
//
// A) A form that stays mounted must restart blank when opened for a FRESH
//    entry — the ApportFormModal kept the previous entry's amount, member,
//    note and photo after a save (its host closes it without the internal
//    reset path), one tap away from a duplicate money record.
// B) A screen must fetch a store whenever it has not resolved for the CURRENT
//    business — never gate on "the list is empty": after a business switch
//    the list is non-empty but holds the PREVIOUS business's rows, and
//    pickers must not display (or write from) that foreign catalogue.
//
// Source-level, like the other wiring contracts in this repo (no
// component-render harness exists).
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('A — ApportFormModal restarts blank for a fresh entry', () => {
  const src = read('app/(app)/apports/index.tsx');

  it('resets on open in add and withdraw modes', () => {
    expect(src).toContain("if (visible && (mode === 'add' || mode === 'withdraw')) reset();");
  });

  it('the reset still clears every field, the picked photo included', () => {
    const resetBody = src.slice(src.indexOf('const reset = () =>'), src.indexOf('// Prefill when opening'));
    for (const setter of ['setAmountStr', 'setSelectedMemberId', 'setSourceName', 'setNote', 'setDate', 'setPhoto']) {
      expect(resetBody).toContain(setter);
    }
    expect(resetBody).toContain('setPhoto(null)');
  });
});

describe('B — fetch guards key on the business the store resolved for', () => {
  it('fournisseurs/[id]: no empty-list guard remains; both stores fetch on unresolved business', () => {
    const src = read('app/(app)/fournisseurs/[id].tsx');
    expect(src).not.toContain('fournisseurs.length === 0');
    expect(src).not.toContain('products.length === 0');
    expect(src).toContain('if (fournisseursFetchedFor !== businessId) fetchFournisseurs(businessId);');
    expect(src).toContain('if (productsFetchedFor !== businessId) fetchProducts(');
  });

  it('fournisseurs/[id]: linked and linkable products only ever come from the resolved catalogue', () => {
    const src = read('app/(app)/fournisseurs/[id].tsx');
    expect(src).toContain('const productsResolved = productsFetchedFor === businessId;');
    expect(src).toContain('const linkedProducts = productsResolved ? products.filter');
    expect(src).toContain('const linkableProducts = productsResolved');
  });

  it('equipe: focus fetch keys on productsFetchedFor, and consumers only see the resolved catalogue', () => {
    const src = read('app/(app)/equipe/index.tsx');
    // (The scope picker's own "Aucun produit disponible" empty state also reads
    // products.length — the guard being banned is the FETCH condition.)
    expect(src).not.toContain('if (products.length === 0) fetchProducts');
    expect(src).toContain('if (productsFetchedFor !== businessId) fetchProducts(businessId, userId);');
    expect(src).toContain('const products = productsFetchedFor === businessId ? rawProducts : [];');
  });
});

describe('housekeeping', () => {
  it('the stale ExpenseSheet.tsx.bak backup is gone (a trap for future editors)', () => {
    expect(existsSync(join(__dirname, '..', 'src/components/expenses/ExpenseSheet.tsx.bak'))).toBe(false);
  });
});
