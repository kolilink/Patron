// Wording 2026-10-16 (his call) : products no longer speak "archiver" to the vendor.
// The shelf state is Actif / Désactivé, the actions Désactiver / Réactiver, the Gérer
// section Désactivés. Copy only — identifiers (archived, archiveProduct…) are unchanged,
// as are the DB field, cache keys and the business-level status in src/types.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

const PRODUCT_FILES = [
  'src/components/QuickAddProductSheet.tsx',
  'src/components/products/useProductSheets.tsx',
  'src/components/products/ProductManager.tsx',
  'src/utils/saveConfirmationCopy.ts',
  'src/utils/failureCopy.ts',
  'stores/products.ts',
];

// Internal tokens that legitimately contain "archiv" (state machine, DB field, caches).
const IDENTIFIER_TOKENS = [
  'archivedConfirmation',
  'getArchivedProductsCache',
  'saveArchivedProductsCache',
  'applyPendingArchived',
  'baseArchivedFor',
  '_baseArchived',
  'archivingIds',
  'archivedProducts',
  'archiveProduct',
  'productNotArchived',
  'isArchiveOp',
  'archived_products',
  'archived',
  'archives',
  'archiveGuard',
];

const stripComments = (src: string) =>
  src
    .replace(/\/\*.*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');

const withoutIdentifiers = (src: string) => {
  let out = src;
  for (const tok of IDENTIFIER_TOKENS) out = out.split(tok).join('');
  return out;
};

describe('product status wording', () => {
  const sheet = read('src/components/QuickAddProductSheet.tsx');
  const hook = read('src/components/products/useProductSheets.tsx');

  it('the sheet owns the actions: "Désactiver ce produit" / "Réactiver ce produit"', () => {
    expect(sheet).toContain('Désactiver ce produit');
    expect(sheet).toContain('Réactiver ce produit');
    expect(sheet).toContain('accessibilityLabel="Désactiver ce produit"');
    expect(sheet).toContain('accessibilityLabel="Réactiver ce produit"');
  });

  it('confirmation, button and restore toast', () => {
    expect(hook).toContain("'Désactiver ce produit ?'");
    expect(hook).toMatch(/text: 'Désactiver', style: 'destructive'/);
    expect(hook).toContain('Vous pourrez le réactiver depuis Gérer.');
    expect(hook).toContain('réactivé ✓');
  });

  it('the toast, the failure sentence and the store error say "désactivé"', () => {
    const { archivedConfirmation } = jest.requireActual('@/src/utils/saveConfirmationCopy') as { archivedConfirmation: (n: string) => string };
    expect(archivedConfirmation('Riz 5kg')).toBe('Riz 5kg désactivé.');
    expect(read('src/utils/failureCopy.ts')).toMatch(/productNotArchived: \{ what: "Le produit n'a pas été désactivé\." \}/);
    expect(read('stores/products.ts')).toMatch(/Impossible de désactiver le produit/);
  });

  it('the Gérer accordion section is "Désactivés"', () => {
    expect(read('src/components/products/ProductManager.tsx')).toContain("label: 'Désactivés'");
  });

  it('no user-visible "Archiv" remains on the product surfaces (identifiers excluded)', () => {
    const hits: string[] = [];
    for (const f of PRODUCT_FILES) {
      const lines = withoutIdentifiers(stripComments(read(f))).split('\n');
      lines.forEach((line, i) => {
        if (/\b[Aa]rchiv/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
