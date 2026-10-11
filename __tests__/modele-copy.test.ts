// "variante" is jargon; vendors say "modèle" (un modèle / des modèles). Copy only —
// code identifiers (product_variants, has_variants, variantDraft…) stay.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const sheet = read('src/components/QuickAddProductSheet.tsx');
const cat = read('src/components/products/ProductManager.tsx');

describe('"Nouveau produit" speaks of modèles', () => {
  it('toggle, column header, add button, remove label, manage link', () => {
    expect(sheet).toMatch(/>Modèles<\/Text>/);                      // toggle
    expect(sheet).toMatch(/>Modèle<\/Text>/);                       // column header (style uppercases it)
    expect(sheet).toMatch(/>Ajouter un modèle<\/Text>/);
    expect(sheet).toMatch(/accessibilityLabel="Retirer ce modèle"/);
    expect(cat).toMatch(/'Modifier · Gérer les modèles'/);
  });
  it('the derived total reads "Total : N" — a count, no unit', () => {
    expect(sheet).toMatch(/Total : \{totalPieces\}/);
  });
  it('the reception screen says "Répartition par modèle"', () => {
    expect(read('app/(app)/fournisseurs/reception.tsx')).toMatch(/Répartition par modèle/);
  });
});

describe('no vendor-visible "variante" is left anywhere in the app', () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
  it('only code identifiers contain it', () => {
    const IDENT = /(product_variants|has_variants|variantDraft|VARIANT_REMOVE_WIDTH|totalVariantStock|upsertVariants|fetchVariants|variantErr|variantExpandBtn)/;
    const root = path.resolve(__dirname, '..');
    const hits: string[] = [];
    for (const dir of ['app', 'src', 'stores', 'lib']) {
      for (const f of walk(path.join(root, dir))) {
        fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
          if (/variante/i.test(line) && !IDENT.test(line)) hits.push(`${path.relative(root, f)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
