import { nextOpenSection } from '@/src/utils/gererSections';
// Gérer mode is plain rows — À compléter (pending drafts) · ONE "Produits" list · a quiet "Archivés (n)" link — whose rows open
// the add/edit sheet. Pure sectioning and the offline store behaviour are tested for real; the screen
// structure is pinned at source level (this repo has no component-render harness).

import fs from 'fs';
import path from 'path';

// ── store mocks (airplane mode: every network call fails) ─────────────────────
const enqueued: { op: string; payload: any }[] = [];
let cachedProducts: any[] = [];
let cachedArchived: any[] = [];
const savedArchived: any[] = [];
const netCalls: string[] = [];

jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  enqueue: async (op: string, payload: any) => { enqueued.push({ op, payload }); },
  getAllQueueItemsForOverlay: async () => ({
    ok: enqueued.map((q, i) => ({ id: i + 1, operation: q.op, payload: JSON.stringify(q.payload), status: 'pending', entity_type: 'produit' })),
    corrupt: [],
  }),
  getProductCache: async () => cachedProducts,
  saveProductCache: async () => {},
  getArchivedProductsCache: async () => cachedArchived,
  saveArchivedProductsCache: async (_b: string, list: any) => { savedArchived.push(list); },
  getVariantsCache: async () => null,
  saveVariantsCache: async () => {},
  getQueueCount: async () => enqueued.length,
  getCacheTimestamp: async () => null,
}));
jest.mock('@/lib/supabase', () => {
  const down = (n: string) => () => { netCalls.push(n); throw new TypeError('Network request failed'); };
  return { supabase: { rpc: down('rpc'), from: down('from'), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } } };
});
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn(), resolveSellerDisplayName: jest.fn() }));
jest.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => ({ session: { activeBusiness: { id: 'b' }, activeMembership: { role: 'administrateur' }, user: { id: 'u' } } }) },
}));

import { buildGererSections, productPieces } from '@/src/utils/gererSections';
import { useProductStore } from '@/stores/products';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const prod = (over: any = {}) => ({
  id: 'p1', business_id: 'b', name: 'Riz', sku: null, category: null, unit: 'pcs', cost_price: 500, sale_price: 1500,
  reorder_level: 0, stock_qty: 12, archived: false, supplier_id: null, purchase_date: null, bulk_price: null, bulk_min_qty: null,
  has_variants: false, created_at: 'x', updated_at: 'x', ...over,
}) as any;
const variant = (over: any = {}) => ({ id: 'v1', product_id: 'p2', name: 'M', cost_price: 100, sale_price: 200, stock_qty: 3, ...over }) as any;

describe('one "Produits" list + archived on the side', () => {
  it('every non-archived product is in ONE list (former en-vente + finis), sorted by name; archived are kept apart', () => {
    const r = buildGererSections({
      products: [prod({ id: 'c', name: 'Thé', stock_qty: 0 }), prod({ id: 'a', name: 'Sucre' }), prod({ id: 'b', name: 'Riz', stock_qty: 0 })],
      archived: [prod({ id: 'z', name: 'Zinc', archived: true })],
    });
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].key).toBe('produits');
    expect(r.sections[0].products.map(p => p.id)).toEqual(['b', 'a', 'c']);       // Riz, Sucre, Thé — zero-stock rows included, no separate section
    expect(r.archives.map(p => p.id)).toEqual(['z']);
    expect(r.total).toBe(4);
  });
  it('the section header carries no count and no old section names exist', () => {
    const r = buildGererSections({ products: [prod()], archived: [] });
    expect(r.sections[0].label).toBe('Produits');
    expect(JSON.stringify(r)).not.toMatch(/EN VENTE|PRODUITS FINIS|ARCHIVÉS/);
  });
  it('no products ⇒ no Produits section (the screen shows its empty state / the Archivés link)', () => {
    expect(buildGererSections({ products: [], archived: [prod({ id: 'z', archived: true })] }).sections).toEqual([]);
    expect(buildGererSections({ products: [], archived: [] })).toEqual({ sections: [], archives: [], total: 0 });
  });
  it('pieces: plain stock, or the sum of the models\' stock (null until they load) — the row shows "0 pcs" itself', () => {
    expect(productPieces(prod({ stock_qty: 12 }))).toBe(12);
    expect(productPieces(prod({ stock_qty: 0 }))).toBe(0);
    expect(productPieces(prod({ has_variants: true, stock_qty: 0 }))).toBeNull();
    expect(productPieces(prod({ has_variants: true, stock_qty: 0 }), [variant({ stock_qty: 4 }), variant({ id: 'v2', stock_qty: 6 })])).toBe(10);
  });
  it('search is accent- and case-insensitive over both the list and the archived products', () => {
    const args = {
      products: [prod({ id: 'b', name: 'Zèbre' }), prod({ id: 'a', name: 'Éponge' })],
      archived: [prod({ id: 'z', name: 'eponge vieille', archived: true })],
    };
    const q = buildGererSections({ ...args, query: 'EPONGE' });
    expect(q.sections[0].products.map(p => p.id)).toEqual(['a']);
    expect(q.archives.map(p => p.id)).toEqual(['z']);
  });
  it('"Valeur du stock" is gone from the data too (it is a report, not a management action)', () => {
    expect(Object.keys(buildGererSections({ products: [prod()], archived: [] }))).toEqual(['sections', 'archives', 'total']);
  });
});

describe('Gérer screen structure', () => {
  const pm = read('src/components/products/ProductManager.tsx');
  it('header: "< Vendre" left, "Gérer" centre, "Terminé" right — both ends go back to sell mode', () => {
    expect(pm).toContain('accessibilityLabel="Retour à Vendre"');
    expect(pm).toMatch(/<Text variant="h4" style=\{styles\.headerTitle\}>Gérer<\/Text>/);
    expect(pm).toContain('accessibilityLabel="Terminer"');
    expect(pm.match(/onPress=\{onExit\}/g)?.length).toBe(2);
  });
  it('"Valeur du stock" is gone from the screen', () => {
    expect(pm).not.toMatch(/Valeur du stock|valueLine|stockValue/);
  });
  it('every section starts collapsed: À compléter / Produits / Archivés are accordion headers (label + count + chevron)', () => {
    expect(pm).toContain("useState<GererAccordionId | null>(null)");
    expect(pm).toMatch(/if \(drafts\.length > 0\) \{/);
    expect(pm).toContain("label: 'À compléter'");
    expect(pm).toContain("label: 'Produits'");
    expect(pm).toContain("label: 'Archivés'");
    expect(pm).toContain('`${item.label} (${item.count})`');
    expect(pm).toMatch(/openSection === item\.id \? 'chevron-up' : 'chevron-down'/);
    // rows only exist in the data when their section is the open one
    expect(pm).toContain("if (openSection === 'drafts')");
    expect(pm).toContain("if (openSection === 'produits')");
    expect(pm).toContain("if (openSection === 'archives')");
    expect(pm).not.toMatch(/draftsCard|draftsHead|setDraftsOpen|archivesOpen|ListFooterComponent/);
    const row = pm.slice(pm.indexOf('function DraftRow'), pm.indexOf('export function ProductManager'));
    expect(row).toContain('style={styles.row}');
    expect(row).toContain('name="close-circle"');                     // × deletes
    expect(row).toContain('onPress={onResume}');                      // tap resumes
    expect(pm).toContain('onDelete={() => deleteDraft(item.draft)}');
  });
  it('accordion: one open at a time, tapping the open header collapses all', () => {
    expect(nextOpenSection(null, 'produits')).toBe('produits');
    expect(nextOpenSection('produits', 'archives')).toBe('archives');
    expect(nextOpenSection('archives', 'archives')).toBeNull();
    expect(nextOpenSection('drafts', 'produits')).toBe('produits');
    expect(pm).toMatch(/setOpenSection\(cur => nextOpenSection\(cur, item\.id\)\)/);
  });
  it('no EN VENTE / PRODUITS FINIS / ARCHIVÉS uppercase sections', () => {
    expect(pm).not.toMatch(/EN VENTE|PRODUITS FINIS|ARCHIVÉS/);
  });
  it('archived rows open the edit sheet (which has Restaurer)', () => {
    expect(pm).toMatch(/item\.archived \? undefined/);
  });
  it('rows show "12 pcs · 1 500 gnf" and a chevron; tapping opens the add/edit sheet (no per-row buttons)', () => {
    expect(pm).toContain("{pcs !== null ? `${pcs} pcs` : 'Modèles'}");
    expect(pm).toContain('${formatAmountValue(product.sale_price, currency)} ${currency.toLowerCase()}');
    expect(pm).toContain('name="chevron-forward"');
    expect(pm).toMatch(/onPress=\{\(\) => sheets\.openEdit\(item\.product,/);
    const row = pm.slice(pm.indexOf('function ManagerRow'), pm.indexOf('// ─── Gérer ───'));
    expect((row.match(/<Pressable/g) || []).length).toBe(1);               // one tap target: the row
    expect(row).not.toMatch(/Archiver|Restaurer|Supprimer|Modifier ·/);
  });
  it('the screen never archives/restores itself — the sheet does', () => {
    expect(pm).not.toMatch(/archiveProduct|restoreProduct|failAlert|appAlert/);
    const sheet = read('src/components/QuickAddProductSheet.tsx');
    expect(sheet).toContain('Archiver ce produit');
    expect(sheet).toContain('Restaurer ce produit');
  });
  it('no catalogue-era UI remains: no tabs, no switch, no action sheets, no stats card', () => {
    for (const gone of ['ArchiveSwitch', 'Non actifs', 'ProductActionSheet', 'RestoreActionSheet', 'ProductFormModal', 'StockAdjustModal', 'tabRow', 'switchTrack', 'statsCard', 'Voir</Text>', "tab === 'archives'", "'actifs'"]) {
      expect(pm).not.toContain(gone);
    }
  });
  it('long-press from the grid opens the edit sheet directly, with a haptic', () => {
    const v = read('app/(app)/(tabs)/vendre.tsx');
    expect(v).toContain('delayLongPress={450}');
    expect(v).toMatch(/onManage \? \(\) => \{ haptics\.select\(\); onManage\(\); \}/);
    expect(v).toMatch(/onManage=\{canManage \? \(\) => productSheets\.openEdit\(item\) : undefined\}/);
  });
});

describe('airplane mode: the list and the archived link render from the local store, archive/restore show at once', () => {
  beforeEach(() => {
    enqueued.length = 0; netCalls.length = 0; savedArchived.length = 0;
    cachedProducts = [prod({ id: 'a', name: 'Sucre' }), prod({ id: 'b', name: 'Thé', stock_qty: 0 })];
    cachedArchived = [prod({ id: 'z', name: 'Zinc', archived: true })];
    useProductStore.getState().reset();
  });

  it('Archivés comes from the cache when the network is down, and a failed refresh is not an error', async () => {
    await useProductStore.getState().fetchArchivedProducts('b');
    expect(useProductStore.getState().archivedProducts.map(p => p.id)).toEqual(['z']);
    expect(useProductStore.getState().error).toBeNull();
    expect(netCalls.length).toBeGreaterThan(0);
  });

  it('all sections populated from cache, then archive → restore reflected immediately (outbox only)', async () => {
    await useProductStore.getState().fetchArchivedProducts('b');
    // the active base is the cache too (first write rebuilds from it)
    expect(await useProductStore.getState().archiveProduct('a', 'b')).toBe(true);
    let s = useProductStore.getState();
    expect(s.products.map(p => p.id)).toEqual(['b']);
    expect(s.archivedProducts.map(p => p.id).sort()).toEqual(['a', 'z']);
    const view = buildGererSections({ products: s.products, archived: s.archivedProducts });
    expect(view.sections[0].products.map(p => p.id)).toEqual(['b']);          // one list…
    expect(view.archives.map(p => p.id).sort()).toEqual(['a', 'z']);          // …archived on the side

    await useProductStore.getState().restoreProduct('z', 'b', 'u');
    s = useProductStore.getState();
    expect(s.archivedProducts.map(p => p.id)).toEqual(['a']);
    expect(s.products.map(p => p.id).sort()).toEqual(['b', 'z']);
    expect(enqueued.map(q => q.op)).toEqual(['update_product', 'update_product']);
    expect(enqueued.map(q => q.payload)).toEqual([{ id: 'a', archived: true }, { id: 'z', archived: false }]);
  });

  it('a successful server refresh refreshes the archived cache (source contract)', () => {
    expect(read('stores/products.ts')).toMatch(/void saveArchivedProductsCache\(businessId, archivedProducts\);/);
    expect(read('lib/db.ts')).toMatch(/keyValue: `archived_products:\$\{businessId\}`/);
  });
});

describe('drawer artifact', () => {
  const d = read('src/components/BusinessDrawer.tsx');
  it('the closed drawer is fully invisible (its shadow used to leave a strip on the left edge)', () => {
    expect(d).toMatch(/opacity: translateX\.value <= -DRAWER_WIDTH \+ 1 \? 0 : 1/);
  });
  it('an interrupted close can no longer leave the modal mounted', () => {
    expect(d).toMatch(/runOnJS\(unmountIfClosed\)\(\)/);
    expect(d).toMatch(/if \(!useAuthStore\.getState\(\)\.businessDrawerOpen\) setModalVisible\(false\)/);
  });
});
