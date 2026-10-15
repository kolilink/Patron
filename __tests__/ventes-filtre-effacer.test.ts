// The « Effacer » class, last survivor (half-done audit, 2026-10-14): the
// Ventes filter no-match state offered a hand-rolled « Effacer » whose tap
// only reset the filter (setFilter('all')) — a label promising deletion on
// a money screen, doing a view change. PR #140's sweep missed it because it
// searched the EmptyState prop shape, not the word. The reset action itself
// is useful and stays; the label now names what it does. These contracts
// pin the no-match block specifically, and the app-wide count discipline:
// after this fix, ventes/index.tsx keeps exactly ONE « Effacer » — the
// filter sheet's draft-clear, which does erase what it names (the draft
// criteria), in a form where that is the ordinary idiom.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const VENTES = read('app/(app)/ventes/index.tsx');

const slice = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  return src.slice(i, src.indexOf(end, i));
};

describe('Ventes — filter no-match state', () => {
  it('the reset action is labeled with what it does', () => {
    const block = slice(VENTES, 'Aucune vente ne correspond à ce filtre', 'FlatList');
    expect(block).toContain('Voir toutes les ventes');
    expect(block).toContain("setFilter('all')");
  });

  it('no « Effacer » remains in the no-match block', () => {
    const block = slice(VENTES, 'Aucune vente ne correspond à ce filtre', 'FlatList');
    expect(block).not.toContain('Effacer');
  });

  it('exactly one « Effacer » survives app-wide in this file: the filter-sheet draft clear', () => {
    expect(VENTES.split('>Effacer<').length - 1).toBe(1);
    expect(VENTES).toContain('onReset={() => { setDraftSelectedProducts([]); setDraftFrom(\'\'); setDraftTo(\'\'); }}');
  });
});
