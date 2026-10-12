// Catalogue → Vendre merge: one tab (sell mode + Gérer mode).
//
// Behavioural tests where the repo has a harness (pure maths, the product store against a mocked
// outbox, the overlay). This repo has NO component-render harness (no JSX transform), so the screen
// wiring — entry points, role gating, derived "any sheet open" — is pinned at source level; that
// pins the contract but is not a substitute for a tap-through on a device.

import fs from 'fs';
import path from 'path';

// ── mocks for the store tests ────────────────────────────────────────────────
const enqueued: { op: string; payload: any }[] = [];
// What the local cache holds for the product list (the BASE the offline overlay is applied on).
let cachedProducts: any[] = [];
const netCalls: string[] = [];

jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  enqueue: async (op: string, payload: any) => { enqueued.push({ op, payload }); },
  getAllQueueItemsForOverlay: async () => ({
    ok: enqueued.map((q, i) => ({ id: i + 1, operation: q.op, payload: JSON.stringify(q.payload), status: 'pending', entity_type: 'produit' })),
    corrupt: [],
  }),
  getProductCache: async () => cachedProducts,
  getQueueCount: async () => enqueued.length,
}));
jest.mock('@/lib/supabase', () => {
  const boom = (n: string) => () => { netCalls.push(n); throw new Error('network down'); };
  return { supabase: { rpc: boom('rpc'), from: boom('from'), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } } };
});
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn(), resolveSellerDisplayName: jest.fn() }));

import { applyPendingArchived, applyPendingProductOps } from '@/lib/pendingProducts';
import { backdropOpacity, BACKDROP_MAX, dragOffset, shouldDismiss, DISMISS_FRACTION, DISMISS_VELOCITY } from '@/src/utils/sheetGesture';
import { editingToState, needsSalePrice, toQuickAddPayload, canSubmit, setModels, patchVariant, addVariant } from '@/src/utils/quickAddProduct';
import { useProductStore } from '@/stores/products';
import { validateOutboxPayload } from '@/lib/outboxValidation';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));
const walk = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(e => {
  const rel = path.join(dir, e.name);
  return e.isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
});

const prod = (over: any = {}) => ({
  id: 'p1', business_id: 'b', name: 'Riz', sku: null, category: null, unit: 'pcs', cost_price: 500, sale_price: 1000,
  reorder_level: 3, stock_qty: 10, archived: false, supplier_id: null, purchase_date: null, bulk_price: null, bulk_min_qty: null,
  has_variants: false, created_at: 'x', updated_at: 'x', ...over,
}) as any;

// ─────────────────────────────────────────────────────────────────────────────
describe('the Produits tab is gone, with zero dangling routes', () => {
  it('the tab file and its registration are deleted', () => {
    expect(exists('app/(app)/(tabs)/catalogue.tsx')).toBe(false);
    const layout = read('app/(app)/(tabs)/_layout.tsx');
    expect(layout).not.toMatch(/name="catalogue"/);
    expect(layout).not.toMatch(/catalogue:\s*\{/);
  });
  it('no source anywhere pushes to the old tab or its openForm deep link', () => {
    const hits: string[] = [];
    for (const dir of ['app', 'src', 'stores', 'lib']) {
      for (const f of walk(dir)) {
        if (f.startsWith(path.join('app', '(app)', 'catalogue'))) continue; // the redirect routes themselves
        read(f).split('\n').forEach((line, i) => {
          if (/\/\(tabs\)\/catalogue|catalogue\?openForm|pathname: '\/\(app\)\/catalogue'/.test(line)) hits.push(`${f}:${i + 1}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
  it('old links (low_stock push, deep links) land somewhere real: redirect routes into Vendre', () => {
    const idx = read('app/(app)/catalogue/index.tsx');
    const byId = read('app/(app)/catalogue/[id].tsx');
    expect(idx).toContain("pathname: '/(app)/(tabs)/vendre'");
    expect(idx).toMatch(/openForm === '1'/);
    expect(byId).toContain("pathname: '/(app)/(tabs)/vendre'");
    expect(byId).toMatch(/focus:/);
    // and the server-side registry's routes still resolve to those redirects
    expect(read('supabase/functions/dispatch-notification/registry.ts')).toContain("routeWithId('/(app)/catalogue', 'product_id')");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('entry-point checklist — every one lands in Vendre, none dangle', () => {
  const vendre = read('app/(app)/(tabs)/vendre.tsx');
  const home = read('app/(app)/(tabs)/index.tsx');
  it('2. empty-state "Ajouter un produit" (offline and online), search no-match and the floating "+" open Vendre\'s own sheet', () => {
    expect(vendre).toMatch(/onLink=\{offline && canManage \? \(\) => productSheets\.openAdd\(\) : undefined\}/);
    expect(vendre).toMatch(/linkLabel="Ajouter un produit"\s*\n\s*onLink=\{\(\) => productSheets\.openAdd\(\)\}/);
    expect(vendre).toMatch(/createLabel=\{`\+ Nouveau produit « \$\{search\.trim\(\)\} »`\}\s*\n\s*onCreate=\{canManage \? \(\) => productSheets\.openAdd\(search\.trim\(\)\)/);
    expect(vendre).toMatch(/onPress=\{\(\) => productSheets\.openAdd\(\)\}\s*\n\s*style=\{\(\{ pressed \}\) => \[styles\.addFab/);
  });
  it('3. there is no ActivationForkOverlay left in the app, so no fork entry to repoint', () => {
    for (const f of [...walk('app'), ...walk('src')]) expect(read(f)).not.toMatch(/ActivationForkOverlay|onSelectProduct/);
  });
  it('4. Home: the low-stock card opens Vendre in Gérer mode; Home has no other product entry or "+ Ajouter" product FAB', () => {
    expect(home).toMatch(/pathname: '\/\(app\)\/\(tabs\)\/vendre', params: \{ gerer: '1' \}/);
    expect(home).not.toMatch(/openForm/);
  });
  it('5. openForm / prefillName / gerer / focus params are handled by Vendre (a mounted tab re-applies them on every arrival)', () => {
    expect(vendre).toMatch(/useLocalSearchParams<\{ openForm\?: string; prefillName\?: string; gerer\?: string; focus\?: string \}>/);
    expect(vendre).toMatch(/productSheets\.openAdd\(prefillName \?\? undefined\)/);
    expect(vendre).toMatch(/router\.setParams\(\{ openForm: undefined, prefillName: undefined \}\)/);
    expect(vendre).toMatch(/if \(gererParam === '1'\)/);
  });
  it('6. a product from a confirmed PO / supplier form appears in the grid: Vendre reads the same product store and refetches on focus', () => {
    expect(vendre).toMatch(/const \{ products: allProducts, [^}]*\} = useProductStore\(\)/);
    expect(vendre).toMatch(/useFocusEffect\(/);
    // sale_price 0 → "Prix à fixer", never "0"
    expect(vendre).toContain('Prix à fixer');
    expect(vendre).toMatch(/if \(canManage\) productSheets\.openEdit\(item\)/);
  });
  it('7. ProductFormModal is gone: the one add/edit sheet is QuickAddProductSheet (edit = "Modifier le produit" / "Enregistrer", closes on save)', () => {
    expect(read('src/components/products/ProductManager.tsx')).not.toMatch(/ProductFormModal|SupplierPicker/);
    const sheet = read('src/components/QuickAddProductSheet.tsx');
    expect(sheet).toContain("isEdit ? 'Modifier le produit' : 'Nouveau produit'");
    expect(sheet).toContain("isEdit ? 'Enregistrer' : 'Ajouter'");
    expect(sheet).toMatch(/if \(isEdit \|\| isDelivery\) return; \/\/ edit \/ delivery: the host closes the sheet/);
    const hook = read('src/components/products/useProductSheets.tsx');
    expect(hook).toMatch(/setEditOpen\(false\);\s*return \{ ok: true \}/);
    // stock is a fact + "Ajuster", fournisseur sits in the (collapsed) Plus d'informations
    expect(sheet).toContain('accessibilityLabel="Ajuster le stock"');
    expect(sheet).toMatch(/Fournisseur<\/Text>/);
  });
  it('8/9. stock adjust, archive / restore and the stats sheet are owned by the edit sheet that Gérer rows open', () => {
    const sheet = read('src/components/QuickAddProductSheet.tsx');
    const hook = read('src/components/products/useProductSheets.tsx');
    expect(sheet).toContain('accessibilityLabel="Ajuster le stock"');
    expect(sheet).toContain('Archiver ce produit');
    expect(sheet).toContain('Restaurer ce produit');
    expect(sheet).toContain('Voir la rentabilité');
    expect(hook).toMatch(/<ProductStatsModal/);
    expect(hook).toMatch(/<StockAdjustModal/);
    expect(hook).toMatch(/onArchive=\{handleArchive\}/);
  });
  it('10. the "catalogue" concept is gone from Vendre\'s empty-state copy', () => {
    expect(vendre).not.toContain('Pas besoin de catalogue pour vendre.');
    expect(vendre).not.toMatch(/Catalogue non disponible|Le catalogue est vide/);
    expect(read('src/components/QuickAddProductSheet.tsx')).not.toMatch(/votre catalogue/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Gérer mode', () => {
  const vendre = read('app/(app)/(tabs)/vendre.tsx');
  const pm = read('src/components/products/ProductManager.tsx');
  it('has the specified management surface: À compléter (n) as plain rows; no Valeur du stock', () => {
    expect(pm).toContain("label: 'À compléter'");
    expect(pm).toContain('deleteDraft(item.draft)');
    expect(pm).not.toMatch(/Valeur du stock/);
    expect(vendre).toMatch(/Prix en \{currency\}/); // sell mode keeps its currency line; Gérer rows carry "… gnf" themselves
  });
  it('per-product affordances: "Prix à fixer" (sale price) and "Prix d\'achat ?" (cost) show on the row, and the row opens the edit sheet', () => {
    expect(pm).toMatch(/Prix d.{1,2}achat \?/);
    expect(pm).toContain('Prix à fixer');
    expect(pm).toMatch(/onPress=\{\(\) => sheets\.openEdit\(item\.product, /);
  });
  it('one-time hint, exact copy, dismissible forever', () => {
    expect(pm).toContain('Astuce : restez appuyé sur un produit pour le modifier');
    expect(pm).toMatch(/setKV\(GERER_HINT_KEY\(userId\), '1'\)/);
    expect(pm).toMatch(/getKV\(GERER_HINT_KEY\(userId\)\)\.then\(v => \{ if \(!v\) setHintVisible\(true\)/);
  });
  it('entered by a visible "Gérer" button AND by long-press (~450ms, haptic on trigger); bulk products keep long-press = bulk', () => {
    expect(vendre).toMatch(/accessibilityLabel="Gérer les produits"/);
    expect(vendre).toContain('delayLongPress={450}');
    expect(vendre).toMatch(/onManage \? \(\) => \{ haptics\.select\(\); onManage\(\); \}/);
    // long-press opens the SAME edit sheet a Gérer row opens — it does not switch mode
    expect(vendre).toMatch(/onManage=\{canManage \? \(\) => productSheets\.openEdit\(item\) : undefined\}/);
    expect(vendre).toMatch(/hasBulk && !outOfStock \? onAddBulk :/);
  });
  it('floating "+" and "Gérer" hide on ONE derived "any sheet open" state (Vendre and Gérer each)', () => {
    expect(vendre).toMatch(/const anySheetOpen = productSheets\.anySheetOpen \|\| variantPickerProduct !== null \|\| showPayment \|\|\s*\n\s*showConfirmSheet \|\| showCartSheet \|\| showQuickCapture \|\| receiptOpen !== null;/);
    expect(vendre).toContain('const showFloating = canManage && products.length > 0 && !anySheetOpen;');
    expect(pm).toMatch(/canEdit && !nothingAtAll && !sheets\.anySheetOpen/);
    expect(read('src/components/products/useProductSheets.tsx')).toMatch(/anySheetOpen: addOpen \|\| editOpen \|\| adjustOpen \|\| statsOpen/);
  });
  it('bulk import has no UI yet (reserved, not built)', () => {
    expect(pm).not.toMatch(/[Ii]mport(er)? (en masse|CSV|des produits)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('role gating — exactly the old catalogue tab\'s audience', () => {
  const vendre = read('app/(app)/(tabs)/vendre.tsx');
  it('Gérer, long-press edit, every "+" and the sheets exist only for administrateur / manager', () => {
    expect(vendre).toContain("const canManage = role === 'administrateur' || role === 'manager';");
    expect(vendre).toContain('onManage={canManage ?');
    expect(vendre).toContain('if (gerer && canManage)');
    expect(vendre).toContain('{canManage && productSheetElements}');
    expect(vendre).toContain('const showFloating = canManage &&');
    expect(vendre).toMatch(/useEffect\(\(\) => \{ if \(!canManage && gerer\) exitGerer\(\); \}/);
    // search no-match "+ Nouveau produit" is only offered to managers
    expect(vendre).toMatch(/onCreate=\{canManage \?/);
  });
  it('a seller tapping a price-less product is told who can fix it (no edit sheet)', () => {
    expect(vendre).toContain("appAlert('Prix manquant', 'Demandez à votre responsable de fixer le prix de ce produit.')");
  });
  it('the vendeur product-scope filter still applies to the grid', () => {
    expect(vendre).toMatch(/if \(!isVendeur \|\| vendeurScopeAll\) return allProducts;\s*\n\s*return allProducts\.filter\(p => vendeurProductScope\.includes\(p\.id\)\);/);
  });
  it('the tab bar has no Produits entry for anyone; investisseur still has no Vendre', () => {
    const layout = read('app/(app)/(tabs)/_layout.tsx');
    expect(layout).toMatch(/name="vendre"[\s\S]*href: isInvestisseur \? null : undefined/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('swipe-down: 1:1 tracking, fling or 50% to dismiss, spring back otherwise', () => {
  it('follows the finger exactly downward and never rises above open', () => {
    expect(dragOffset(0)).toBe(0);
    expect(dragOffset(37.5)).toBe(37.5);
    expect(dragOffset(-60)).toBe(0);
  });
  it('dismisses past half the sheet, or on a fling at any distance; otherwise springs back', () => {
    const H = 600;
    expect(DISMISS_FRACTION).toBe(0.5);
    expect(shouldDismiss(H * 0.5, 0, H)).toBe(true);
    expect(shouldDismiss(H * 0.49, 0, H)).toBe(false);
    expect(shouldDismiss(10, DISMISS_VELOCITY, H)).toBe(true);
    expect(shouldDismiss(10, DISMISS_VELOCITY - 1, H)).toBe(false);
    expect(shouldDismiss(0, 0, 0)).toBe(false);
  });
  it('the backdrop dim is a pure function of the drag: full when open, none when gone, linear between', () => {
    expect(backdropOpacity(0, 600)).toBe(BACKDROP_MAX);
    expect(backdropOpacity(600, 600)).toBe(0);
    expect(backdropOpacity(300, 600)).toBeCloseTo(BACKDROP_MAX / 2, 5);
    expect(backdropOpacity(900, 600)).toBe(0);
  });
  it('the sheet is built on it: UI-thread pan on the header, opaque sheet, backdrop from the same shared value', () => {
    const g = read('src/components/ui/GestureSheet.tsx');
    expect(g).toContain('Gesture.Pan()');
    expect(g).toContain('translateY.value = e.translationY > 0 ? e.translationY : 0');
    expect(g).toMatch(/e\.velocityY >= DISMISS_VELOCITY \|\| translateY\.value >= h \* DISMISS_FRACTION/);
    expect(g).toContain('withSpring(0');
    expect(g).toMatch(/opacity: 1 - t/);
    expect(g).toContain('statusBarTranslucent');
    expect(g).toContain('navigationBarTranslucent');
    // opaque sheet: no translucent background that could let the grid bleed through mid-animation
    expect(g).toMatch(/sheet: \{[^}]*backgroundColor: p\.background/);
    expect(read('src/components/QuickAddProductSheet.tsx')).toContain('<GestureSheet');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('edit mode of the shared sheet', () => {
  const C = 'GNF';
  it('loads the stored product; stock is a fact (qty = stock), models come with their own stock locked', () => {
    const s = editingToState(prod({ stock_qty: 7, cost_price: 1234.8, sale_price: 2000 }), [], C);
    expect(s).toMatchObject({ name: 'Riz', price: '2 000', qty: '7', models: false });
    const v = editingToState(prod({ has_variants: true }), [{ id: 'v1', name: 'M', sale_price: 3000, cost_price: 1500, stock_qty: 4 } as any], C);
    expect(v.variants[0]).toMatchObject({ key: 'v1', name: 'M', qty: '4', locked: true, cost: 1500 });
  });
  it('saving without touching cost never rewrites it; reorder level and unit are carried over', () => {
    const p = prod({ cost_price: 1234.8, reorder_level: 3, unit: 'sac', stock_qty: 7 });
    const out = toQuickAddPayload(editingToState(p, [], C), C, { reorder_level: p.reorder_level, unit: p.unit, cost_price: p.cost_price });
    expect(out.data.cost_price).toBe(1234.8);
    expect(out.data).toMatchObject({ reorder_level: 3, unit: 'sac' });
  });
  it('editing the purchase price or adding fees does change the stored cost', () => {
    const p = prod({ cost_price: 1000, stock_qty: 10 });
    const base = editingToState(p, [], C);
    const ex = { reorder_level: 0, unit: 'pcs', cost_price: 1000 };
    expect(toQuickAddPayload({ ...base, purchasePrice: '1 200' }, C, ex).data.cost_price).toBe(1200);
    expect(toQuickAddPayload({ ...base, fees: '500' }, C, ex).data.cost_price).toBe(1050); // 1000 + 500/10 pieces
  });
  it('existing models keep their own cost; new ones get the product cost', () => {
    const p = prod({ has_variants: true, cost_price: 1000 });
    let s = editingToState(p, [{ id: 'v1', name: 'M', sale_price: 3000, cost_price: 1500, stock_qty: 4 } as any], C);
    s = patchVariant(addVariant(s), s.variants.length ? 'zzz' : 'zzz', {});
    const out = toQuickAddPayload(s, C, { reorder_level: 0, unit: 'pcs', cost_price: 1000 });
    expect(out.variants.find(v => v.name === 'M')?.cost_price).toBe(1500);
    expect(out.variants.find(v => v.name === 'M')?.stock_qty).toBe(4);
  });
  it('a product the model switch turns on keeps working through the same payload path', () => {
    const s = setModels(editingToState(prod({ stock_qty: 5 }), [], C), true);
    expect(s.variants[0].qty).toBe('5');
    expect(canSubmit(s)).toBe(true);
  });
  it('plain-product edits never touch the online-only models RPC (so they work offline)', () => {
    const hook = read('src/components/products/useProductSheets.tsx');
    expect(hook).toMatch(/const touchesModels = hasVariants \|\| !!editTarget\.has_variants;/);
    expect(hook).toMatch(/if \(touchesModels\) \{/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('offline contract: every Gérer action goes through the outbox and shows at once', () => {
  beforeEach(() => {
    enqueued.length = 0; netCalls.length = 0; cachedProducts = [];
    useProductStore.getState().reset();
  });

  it('add → edit → stock adjust → archive → restore, all offline: queued, no network, reflected before any sync', async () => {
    const st = useProductStore.getState();
    // add
    expect(await st.createProduct('b', 'u', { name: 'Savon', unit: 'pcs', cost_price: 0, sale_price: 0, reorder_level: 0, initial_stock: 3 })).toBe(true);
    const created = useProductStore.getState().products.find(p => p.name === 'Savon')!;
    expect(created).toBeTruthy();
    expect(needsSalePrice(created)).toBe(true);
    // edit (price fix)
    expect(await st.updateProduct('b', 'u', created.id, { sale_price: 750 })).toBe(true);
    expect(useProductStore.getState().products.find(p => p.id === created.id)!.sale_price).toBe(750);
    // stock adjust
    expect(await st.adjustStock(created.id, 'b', 'u', 2, 'entree')).toBe(true);
    expect(useProductStore.getState().products.find(p => p.id === created.id)!.stock_qty).toBe(5);
    // archive
    expect(await st.archiveProduct(created.id, 'b')).toBe(true);
    expect(useProductStore.getState().products.some(p => p.id === created.id)).toBe(false);
    expect(useProductStore.getState().archivedProducts.some(p => p.id === created.id)).toBe(true);
    // restore
    await st.restoreProduct(created.id, 'b', 'u');
    expect(useProductStore.getState().products.some(p => p.id === created.id)).toBe(true);
    expect(useProductStore.getState().archivedProducts.some(p => p.id === created.id)).toBe(false);

    expect(netCalls).toEqual([]);
    expect(enqueued.map(q => q.op)).toEqual(['create_product', 'update_product', 'adjust_stock_move', 'update_product', 'update_product']);
    // every write carries a client-generated id the replay is idempotent on
    expect(enqueued[0].payload.product.id).toBe(created.id);
    expect(enqueued[2].payload.p_move_id).toEqual(expect.any(String));
    expect(enqueued[3].payload).toEqual({ id: created.id, archived: true });
    expect(enqueued[4].payload).toEqual({ id: created.id, archived: false });
  });

  it('archiving a product that came from the server list moves it to "non actifs" immediately, offline', async () => {
    // Offline, the grid's base is the local cache of the last server list.
    cachedProducts = [prod({ id: 'srv1', name: 'Sucre' }), prod({ id: 'srv2', name: 'Thé' })];
    expect(await useProductStore.getState().archiveProduct('srv1', 'b')).toBe(true);
    expect(useProductStore.getState().products.map(p => p.id)).toEqual(['srv2']);
    expect(useProductStore.getState().archivedProducts.map(p => p.id)).toEqual(['srv1']);
    await useProductStore.getState().restoreProduct('srv1', 'b', 'u');
    expect(useProductStore.getState().products.map(p => p.id).sort()).toEqual(['srv1', 'srv2']);
    expect(netCalls).toEqual([]);
  });

  it('archive / restore payloads are valid outbox payloads (and a non-boolean "archived" is refused)', () => {
    const ok = (p: any) => { try { validateOutboxPayload('update_product', p); return true; } catch { return false; } };
    expect(ok({ id: '3f2b8c4e-1111-4222-8333-444455556666', archived: true })).toBe(true);
    expect(ok({ id: '3f2b8c4e-1111-4222-8333-444455556666', archived: false })).toBe(true);
    expect(ok({ id: '3f2b8c4e-1111-4222-8333-444455556666', archived: 'yes' })).toBe(false);
  });

  it('empty + offline is the true empty state: Gérer renders the empty state from the local store, never a loader', () => {
    const pm = read('src/components/products/ProductManager.tsx');
    expect(pm).toMatch(/\{loading && nothingAtAll && !offline \? \(\s*\n\s*<SkeletonList/);
    expect(pm).toMatch(/\) : nothingAtAll \? \(\s*\n\s*<>\s*\n\s*\{header\}\s*\n\s*<EmptyState/);
  });
});

describe('pending-ops overlay: archive / restore', () => {
  const a = prod({ id: 'a', name: 'A' });
  const b = prod({ id: 'b', name: 'B' });
  const arch = prod({ id: 'z', name: 'Z', archived: true });
  it('a queued archive removes the product from the active list and adds it to non actifs', () => {
    const ops = [{ operation: 'update_product', payload: { id: 'a', archived: true } }];
    expect(applyPendingProductOps([a, b], ops).map(p => p.id)).toEqual(['b']);
    expect(applyPendingArchived([arch], [a, b], ops).map(p => p.id).sort()).toEqual(['a', 'z']);
  });
  it('a queued restore brings a non-actif back and empties it from that list', () => {
    const ops = [{ operation: 'update_product', payload: { id: 'z', archived: false } }];
    expect(applyPendingProductOps([a], ops, undefined, [arch]).map(p => p.id)).toEqual(['a', 'z']);
    expect(applyPendingArchived([arch], [a], ops)).toEqual([]);
  });
  it('archive then restore in the same queue nets out', () => {
    const ops = [
      { operation: 'update_product', payload: { id: 'a', archived: true } },
      { operation: 'update_product', payload: { id: 'a', archived: false } },
    ];
    expect(applyPendingProductOps([a, b], ops, undefined, []).map(p => p.id).sort()).toEqual(['a', 'b']);
    expect(applyPendingArchived([], [a, b], ops)).toEqual([]);
  });
  it('a product created offline, then archived and restored before any sync, is not lost', () => {
    const create = { operation: 'create_product', payload: { product: { id: 'n', business_id: 'b', name: 'Neuf', unit: 'pcs', cost_price: 0, sale_price: 0, stock_qty: 1, reorder_level: 0, archived: false } } };
    const arch = { operation: 'update_product', payload: { id: 'n', archived: true } };
    const rest = { operation: 'update_product', payload: { id: 'n', archived: false } };
    expect(applyPendingProductOps([a], [create, arch]).map(p => p.id)).toEqual(['a']);
    expect(applyPendingArchived([], [a], [create, arch]).map(p => p.id)).toEqual(['n']);
    expect(applyPendingProductOps([a], [create, arch, rest]).map(p => p.id).sort()).toEqual(['a', 'n']);
    expect(applyPendingArchived([], [a], [create, arch, rest])).toEqual([]);
  });
  it('an ordinary price edit is unaffected', () => {
    const out = applyPendingProductOps([a], [{ operation: 'update_product', payload: { id: 'a', sale_price: 90000 } }]);
    expect(out[0].sale_price).toBe(900);
  });
});
