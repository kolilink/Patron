// Catalogue: "archiver / archivé" became "désactiver / non actif" (vendors think of a
// product as active or not), and the "Non actifs" toggle only exists once at least one
// product has been deactivated. Copy only — identifiers (archived, archiveProduct…) stay.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const cat = read('app/(app)/(tabs)/catalogue.tsx');

describe('wording', () => {
  it('toggle, action, confirmation, in-flight word and row note', () => {
    expect(cat).toMatch(/\{t === 'actifs' \? 'Actifs' : 'Non actifs'\}/);
    expect(cat).toMatch(/>Désactiver<\/Text>/);
    expect(cat).toMatch(/'Désactiver ce produit \?'/);
    expect(cat).toMatch(/text: 'Désactiver', style: 'destructive'/);
    expect(cat).toMatch(/depuis l'onglet Non actifs\./);
    expect(cat).toMatch(/<LoadingStatus word="Désactivation"/);
    expect(cat).toMatch(/Ce produit n'est plus actif/);
  });
  it('the header count agrees in number: "1 non actif" / "3 non actifs"', () => {
    expect(cat).toMatch(/`\$\{archivedProducts\.length\} non actif\$\{archivedProducts\.length !== 1 \? 's' : ''\}`/);
    const line = (n: number) => `${n} non actif${n !== 1 ? 's' : ''}`;
    expect([line(1), line(3)]).toEqual(['1 non actif', '3 non actifs']);
  });
  it('the toast, the failure sentence and the store error say "désactivé"', () => {
    const { archivedConfirmation } = jest.requireActual('@/src/utils/saveConfirmationCopy') as { archivedConfirmation: (n: string) => string };
    expect(archivedConfirmation('Riz 5kg')).toBe('Riz 5kg désactivé.');
    expect(read('src/utils/failureCopy.ts')).toMatch(/productNotArchived: \{ what: "Le produit n'a pas été désactivé\." \}/);
    expect(read('stores/products.ts')).toMatch(/Impossible de désactiver le produit/);
  });
  it('no vendor-visible "archiv…" copy is left in app/, src/ or stores/', () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
    });
    const root = path.resolve(__dirname, '..');
    const hits: string[] = [];
    for (const dir of ['app', 'src', 'stores']) for (const f of walk(path.join(root, dir))) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('/*')) return;
        if (/archiv(é|er|és|age|ez)/i.test(line)) hits.push(`${path.relative(root, f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe('the "Non actifs" toggle only exists when something has been deactivated', () => {
  it('rendered only with at least one non-active product', () => {
    expect(cat).toMatch(/\{!showActivationEmptyState && archivedProducts\.length > 0 && \(\s*<View style=\{styles\.tabRow\}>\s*<ArchiveSwitch/);
  });
  it('reactivating the last one while on that tab lands back on Actifs', () => {
    expect(cat).toMatch(/if \(tab === 'archives' && archivedProducts\.length === 0\) setTab\('actifs'\);/);
  });
});
