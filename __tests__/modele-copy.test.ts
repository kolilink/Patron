// "variante" is jargon; vendors say "modèle" (un modèle / des modèles). Copy only —
// code identifiers (product_variants, has_variants, variantDraft…) stay.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const cat = read('app/(app)/(tabs)/catalogue.tsx');

describe('"Nouveau produit" speaks of modèles', () => {
  it('toggle, column header, add button, remove label, manage link', () => {
    expect(cat).toMatch(/>Modèles<\/Text>/);                       // toggle
    expect(cat).toMatch(/\n\s+Modèles\n/);                          // column header (style uppercases it)
    expect(cat).toMatch(/>Ajouter un modèle<\/Text>/);
    expect(cat).toMatch(/accessibilityLabel="Retirer ce modèle"/);
    expect(cat).toMatch(/'Modifier · Gérer les modèles'/);
  });
  it('the stock total line pluralises "1 modèle" / "3 modèles"', () => {
    const m = cat.match(/sur \{variantDraft\.length\} modèle\{variantDraft\.length !== 1 \? 's' : ''\}/);
    expect(m).not.toBeNull();
    const line = (n: number) => `${n} modèle${n !== 1 ? 's' : ''}`;
    expect([line(1), line(2), line(3)]).toEqual(['1 modèle', '2 modèles', '3 modèles']);
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
