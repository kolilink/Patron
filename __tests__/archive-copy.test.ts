// Gérer mode speaks of "archivés" (section ARCHIVÉS, "Archiver ce produit" / "Restaurer ce produit").
// This replaces the earlier "désactiver / non actif" wording; there must be no mix of the two.
// Copy only — identifiers (archived, archiveProduct…) are unchanged.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const walk = (d: string): string[] => fs.readdirSync(path.resolve(__dirname, '..', d), { withFileTypes: true }).flatMap(e => {
  const rel = path.join(d, e.name);
  return e.isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
});

describe('archive wording', () => {
  const sheet = read('src/components/QuickAddProductSheet.tsx');
  const hook = read('src/components/products/useProductSheets.tsx');
  it('the sheet owns the actions: "Archiver ce produit" / "Restaurer ce produit"', () => {
    expect(sheet).toContain('Archiver ce produit');
    expect(sheet).toContain('Restaurer ce produit');
  });
  it('confirmation, button and restore toast', () => {
    expect(hook).toContain("'Archiver ce produit ?'");
    expect(hook).toMatch(/text: 'Archiver', style: 'destructive'/);
    expect(hook).toContain('restauré ✓');
  });
  it('the toast, the failure sentence and the store error say "archivé"', () => {
    const { archivedConfirmation } = jest.requireActual('@/src/utils/saveConfirmationCopy') as { archivedConfirmation: (n: string) => string };
    expect(archivedConfirmation('Riz 5kg')).toBe('Riz 5kg archivé.');
    expect(read('src/utils/failureCopy.ts')).toMatch(/productNotArchived: \{ what: "Le produit n'a pas été archivé\." \}/);
    expect(read('stores/products.ts')).toMatch(/Impossible d'archiver le produit/);
  });
  it('the old "Non actifs / désactiver" product wording is gone everywhere vendor-visible', () => {
    const hits: string[] = [];
    for (const dir of ['app', 'src', 'stores']) for (const f of walk(dir)) {
      read(f).split('\n').forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        if (/Non actifs?|non actifs?|Désactiver ce produit|Réactiver|réactivé/.test(line)) hits.push(`${f}:${i + 1}: ${t}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
