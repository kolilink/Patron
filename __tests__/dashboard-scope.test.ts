// Accueil answers two questions: "How am I selling?" and "Who owes me?".
// Expense figures, expense-derived profit and the best-sellers list live
// elsewhere (Dépenses / Rapports). Pinned at source level, the same hermetic
// approach as the other screen pins (no component tests in this repo).
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '..', 'app/(app)/(tabs)/index.tsx'), 'utf8');
const totals = readFileSync(join(__dirname, '..', 'src/utils/salesTotals.ts'), 'utf8');

describe('Accueil scope — sales + debts only', () => {
  it('no best-sellers section', () => {
    expect(src).not.toMatch(/Produits qui marchent/);
    expect(src).not.toMatch(/visibleBestSellers/);
  });

  it('no expense figure and no expense-derived profit', () => {
    expect(src).not.toMatch(/expenses_month/);
    expect(totals).not.toMatch(/expenses_month/);
    expect(src).not.toMatch(/monthNet/);
    expect(src).not.toMatch(/net_profit/);
    expect(src).not.toMatch(/bénéfice de/);
  });

  it('still shows sales and debts', () => {
    expect(src).toMatch(/revenue_today/);
    expect(src).toMatch(/credit_total/);
    expect(src).toMatch(/credit_count/);
  });

  it('best sellers are only fetched for an investisseur (their own stake figures)', () => {
    expect(src).toMatch(/isInvestisseur \? loadBestSellers\(\) : Promise\.resolve\(\)/);
  });
});
