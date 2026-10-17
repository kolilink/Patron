import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..');
const sheet = readFileSync(join(root, 'src/components/sales/AgreedPriceSheet.tsx'), 'utf8');
const vendre = readFileSync(join(root, 'app/(app)/(tabs)/vendre.tsx'), 'utf8');

describe('Prix convenu — copy and structure contracts', () => {
  it('the sheet says Prix convenu / Prix habituel : / Total :', () => {
    expect(sheet).toContain('Prix convenu');
    expect(sheet).toContain('Prix habituel : ');
    expect(sheet).toContain('Total : ');
    expect(sheet).toContain('par pièce');
    expect(sheet).toContain('Annuler');
    expect(sheet).toContain('Valider');
  });

  it('never says "Total de la ligne"', () => {
    expect(sheet).not.toContain('Total de la ligne');
    expect(vendre).not.toContain('Total de la ligne');
  });

  it('the chip shows "/ unit" and the "· convenu" state, labelled for accessibility', () => {
    expect(vendre).toContain("' · convenu'");
    expect(vendre).toMatch(/\} \/ \$\{line\.is_bulk \? 'lot' : line\.product\.unit\}/);
    expect(vendre).toContain('Modifier le prix de ${line.product.name}');
  });

  it('reuses ExpenseKeypad (no second keypad) inside a FormSheet', () => {
    expect(sheet).toContain("import { ExpenseKeypad } from '@/src/components/expenses/ExpenseKeypad'");
    expect(sheet).toContain('<FormSheet');
    expect(sheet).not.toMatch(/keyboardType|<TextInput/);
  });

  it('the cart row renders the struck catalogue total beside the total, always laid out', () => {
    expect(vendre).toContain('cart-line-catalog-total');
    expect(vendre).toContain("textDecorationLine: 'line-through'");
  });
});
