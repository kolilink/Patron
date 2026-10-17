// Dépenses render (fix #1 of the "vendor waits on the machine" sweep): the old
// render mapped the whole unbounded history into one ScrollView, so the
// screen degraded with every month of business age. These contracts pin the
// virtualized shape: a SectionList (pending block + month accordions), the
// « Charger les mois précédents » extension wired to the store, and an empty
// state that never lies about older history.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SCREEN = read('app/(app)/depenses/index.tsx');
const STORE = read('stores/expenses.ts');

describe('dépenses list is virtualized, not an unbounded ScrollView', () => {
  it('renders a SectionList with section headers, items and a footer', () => {
    expect(SCREEN).toContain('SectionList');
    expect(SCREEN).toContain('renderSectionHeader');
    expect(SCREEN).toContain('ListFooterComponent');
    expect(SCREEN).toContain('keyExtractor');
  });

  it('no ScrollView maps the full history anymore', () => {
    expect(SCREEN).not.toContain('<ScrollView');
    expect(SCREEN).not.toContain('{pendingExpenses.map(');
    expect(SCREEN).not.toContain('{months.map(');
    expect(SCREEN).not.toContain('{d.items.map(');
  });

  it('month accordions keep their visual shape (header + total + chevron, day labels, same rows)', () => {
    expect(SCREEN).toContain('monthHeader');
    expect(SCREEN).toContain('CountUpAmount');
    expect(SCREEN).toContain('dayLabel');
    expect(SCREEN).toContain('EN ATTENTE ·');
    expect(SCREEN).toContain('renderRow');
  });
});

describe('« Charger les mois précédents » is wired end to end', () => {
  it('the screen calls the store extend action and shows it only when older expenses exist', () => {
    expect(SCREEN).toContain('extendExpensesWindow');
    expect(SCREEN).toContain('expensesBeyondWindow');
    expect(SCREEN).toContain('Charger les mois précédents');
  });

  it('the store widens the window by 6 months and tracks what the list covers', () => {
    expect(STORE).toContain('extendExpensesWindow');
    expect(STORE).toContain('expensesWindowStart');
    expect(STORE).toContain('previousExpenseWindowStart');
    expect(STORE).toContain('expensesBeyondWindow');
  });

  it('the window floor never excludes pending rows', () => {
    expect(STORE).toContain('status.eq.en_attente');
  });

  it('the beyond-window probe only counts non-pending rows older than the window', () => {
    const probeStart = STORE.indexOf('probeBeyondWindow = async');
    const probeBody = STORE.slice(probeStart, STORE.indexOf('};', probeStart));
    expect(probeBody).toContain(".lt('date', windowStart)");
    expect(probeBody).toContain(".neq('status', 'en_attente')");
  });
});

describe('the empty state never lies about older history', () => {
  it('a dedicated honest state exists when the window is empty but history predates it', () => {
    expect(SCREEN).toContain('expensesBeyondWindow');
    expect(SCREEN).toContain('il y en a avant');
  });

  it('the true zero state (new business) keeps its wording and its + Dépense action', () => {
    expect(SCREEN).toContain('Aucune dépense pour le moment');
    expect(SCREEN).toContain('actionLabel="+ Dépense"');
  });
});
