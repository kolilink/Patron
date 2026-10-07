import {
  pressKey, keypadValue, dayLabel, groupByMonthAndDay, sumApproved, recentTemplates,
  searchProducts, rankLinkedProducts, pinRecents,
} from '@/src/utils/expenseUtils';
import type { Expense } from '@/src/types';

const exp = (o: Partial<Expense>): Expense => ({
  id: Math.random().toString(36).slice(2), business_id: 'b', amount: 1000, description: 'Dépense', category: null,
  date: '2026-10-05', due_date: null, note: null, status: 'approuve', created_by: 'u', approved_by: null,
  approved_at: null, created_at: '2026-10-05T10:00:00Z', updated_at: '2026-10-05T10:00:00Z', ...o,
});

describe('keypad', () => {
  it('builds a GNF amount with the 000 key', () => {
    let r = '';
    r = pressKey(r, '2', 'GNF'); r = pressKey(r, '5', 'GNF'); r = pressKey(r, '000', 'GNF');
    expect(r).toBe('25000');
    expect(keypadValue(r)).toBe(25000);
  });
  it('000 on empty and leading zeros stay empty', () => {
    expect(pressKey('', '000', 'GNF')).toBe('');
    expect(pressKey('', '0', 'GNF')).toBe('');
    expect(pressKey('0', '5', 'GNF')).toBe('5');
  });
  it('backspace removes the last digit and is safe on empty', () => {
    expect(pressKey('250', 'back', 'GNF')).toBe('25');
    expect(pressKey('', 'back', 'GNF')).toBe('');
  });
  it('whole-unit currencies ignore the separator key', () => {
    expect(pressKey('12', 'dot', 'GNF')).toBe('12');
  });
  it('decimal currencies take one separator and at most 2 decimals', () => {
    let r = pressKey('', 'dot', 'USD');
    expect(r).toBe('0.');
    r = pressKey(pressKey(pressKey(r, '5', 'USD'), '2', 'USD'), '9', 'USD');
    expect(r).toBe('0.52');
    expect(pressKey(r, 'dot', 'USD')).toBe('0.52');
  });
  it('caps the length', () => {
    let r = '';
    for (let i = 0; i < 20; i++) r = pressKey(r, '9', 'GNF');
    expect(r.length).toBe(12);
  });
});

describe('day labels and grouping', () => {
  const now = new Date(2026, 9, 5, 12);
  it('labels today, yesterday, other days', () => {
    expect(dayLabel('2026-10-05', now)).toBe("Aujourd'hui");
    expect(dayLabel('2026-10-04', now)).toBe('Hier');
    expect(dayLabel('2026-10-01', now)).toMatch(/1.*oct.*2026/);
  });
  it('month total is the live sum of approved rows only', () => {
    const rows = [
      exp({ amount: 2500, date: '2026-10-05' }),
      exp({ amount: 1500, date: '2026-10-04' }),
      exp({ amount: 9999, date: '2026-10-04', status: 'en_attente' }),
      exp({ amount: 700, date: '2026-09-30' }),
    ];
    const g = groupByMonthAndDay(rows, now);
    expect(g.map(m => m.key)).toEqual(['2026-10', '2026-09']);
    expect(g[0].total).toBe(4000);
    expect(g[0].days.map(d => d.label)).toEqual(["Aujourd'hui", 'Hier']);
    expect(g[0].total).toBe(sumApproved(rows.filter(r => r.date.startsWith('2026-10'))));
  });
  it('removing a row moves the total by exactly its amount', () => {
    const a = exp({ amount: 2500 }); const b = exp({ amount: 1000 });
    expect(groupByMonthAndDay([a, b], new Date(2026, 9, 5))[0].total).toBe(3500);
    expect(groupByMonthAndDay([b], new Date(2026, 9, 5))[0].total).toBe(1000);
  });
});

describe('Répéter', () => {
  it('no history → no templates (the UI renders nothing)', () => {
    expect(recentTemplates([])).toEqual([]);
  });
  it('dedupes identical amount+product+note, newest first', () => {
    const t = recentTemplates([
      exp({ amount: 100, product_id: 'p', created_at: '2026-10-01T00:00:00Z' }),
      exp({ amount: 100, product_id: 'p', created_at: '2026-10-03T00:00:00Z' }),
      exp({ amount: 200, note: 'Taxi', created_at: '2026-10-02T00:00:00Z' }),
    ]);
    expect(t.map(x => x.amount)).toEqual([100, 200]);
  });
});

describe('product search / récents', () => {
  const products = [
    { id: '1', name: 'Huile d’arachide' }, { id: '2', name: 'Riz 50 kg' },
    { id: '3', name: 'Riz parfumé' }, { id: '4', name: 'Été sucre' },
  ];
  it('empty query renders nothing; matches ignore case and accents; prefix first', () => {
    expect(searchProducts(products, '')).toEqual([]);
    expect(searchProducts(products, 'riz').map(p => p.id)).toEqual(['2', '3']);
    expect(searchProducts(products, 'ete').map(p => p.id)).toEqual(['4']);
    expect(searchProducts(products, 'sucre').map(p => p.id)).toEqual(['4']);
  });
  it('never returns more than 20 for a catalogue of hundreds', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: String(i), name: `Riz ${i}` }));
    expect(searchProducts(many, 'riz')).toHaveLength(20);
  });
  it('no match → empty (UI shows "Aucun produit")', () => {
    expect(searchProducts(products, 'zzz')).toEqual([]);
  });
  it('ranks by link count and pins order', () => {
    const rows = [exp({ product_id: 'a' }), exp({ product_id: 'b' }), exp({ product_id: 'b' }), exp({ product_id: null })];
    expect(rankLinkedProducts(rows)).toEqual(['b', 'a']);
    expect(pinRecents([], ['b', 'a'])).toEqual(['b', 'a']);
    // counts flip, order stays pinned
    expect(pinRecents(['b', 'a'], ['a', 'b'])).toEqual(['b', 'a']);
    // a pinned id that vanished from the ranking is replaced, others keep their slot
    expect(pinRecents(['b', 'a'], ['a', 'c'])).toEqual(['a', 'c']);
    expect(pinRecents(['a'], ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 3)).toEqual(['a', 'b', 'c']);
  });
});

describe('showProductRow — the optional "Produit (facultatif)" row', () => {
  const { showProductRow } = jest.requireActual('@/src/utils/expenseUtils') as typeof import('@/src/utils/expenseUtils');
  const BIZ = 'biz-1';

  it('(a) products present → row visible', () => {
    expect(showProductRow({ activeProductCount: 3, productId: null, productsFetchedFor: BIZ, businessId: BIZ })).toBe(true);
  });
  it('(b) fetched for this business + zero products + nothing linked → row absent', () => {
    expect(showProductRow({ activeProductCount: 0, productId: null, productsFetchedFor: BIZ, businessId: BIZ })).toBe(false);
  });
  it('(c) a product already linked + zero (active) products → chip stays visible', () => {
    expect(showProductRow({ activeProductCount: 0, productId: 'p-archived', productsFetchedFor: BIZ, businessId: BIZ })).toBe(true);
  });
  it('not loaded yet + no product → hidden (appears once a product exists)', () => {
    expect(showProductRow({ activeProductCount: 0, productId: null, productsFetchedFor: null, businessId: BIZ })).toBe(false);
    expect(showProductRow({ activeProductCount: 0, productId: null, productsFetchedFor: 'other', businessId: BIZ })).toBe(false);
  });
  it('the sheet wraps the whole block in it and nothing else changed', () => {
    const src = require('fs').readFileSync(require('path').resolve(__dirname, '../src/components/expenses/ExpenseSheet.tsx'), 'utf8');
    expect(src).toMatch(/\{showProductRow\(\{ activeProductCount: activeProducts\.length, productId, productsFetchedFor, businessId \}\) && \(/);
    expect(src).toMatch(/productsFetchedFor \} = useProductStore\(\)/);
    expect(src).toMatch(/Choisir un produit/);
  });
});
