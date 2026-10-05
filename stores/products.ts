import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { generateId, generateFallbackName } from '@/lib/id';
import { saveProductCache, getProductCache, enqueue, getQueueCount, getCacheTimestamp, saveVariantsCache, getVariantsCache } from '@/lib/db';
import { isNetworkError, withNetworkRetry, reportOfflineFallback } from '@/lib/sync';
import { useSyncStore } from '@/stores/sync';
import { useAuthStore } from '@/stores/auth';
import { trackEvent } from '@/lib/analytics';
import { notifyEvent } from '@/src/utils/notifications';
import { formatAmount } from '@/src/utils/format';
import { createKeyedInflightGuard } from '@/lib/inflight';

// One archive per product at a time: a double-tap on a slow connection must not fire twice.
const archiveGuard = createKeyedInflightGuard();
import type { Product, ProductVariant } from '@/src/types';

// Every fetch* function below is called with a specific businessId, but by
// the time its network/cache round trip resolves, the user may have already
// switched to a different business — selectBusiness() (stores/auth.ts)
// resets every store's in-memory state synchronously on switch, but a
// fetch already in flight from the *previous* business doesn't know that
// happened and, without this check, would go on to overwrite the new
// business's freshly-loaded state with stale cross-business data once it
// finally resolves. Longer round trips (offline, the 12s network timeout
// added earlier) make this race far more likely to actually land, not just
// theoretical. Call right before every set() that writes fetched data.
function isStaleBusiness(businessId: string): boolean {
  return useAuthStore.getState().session?.activeBusiness?.id !== businessId;
}

// Per-session deduplication: avoid notifying the same low-stock product twice per session.
// Reset happens when the store resets (logout / business switch).
const notifiedLowStockIds = new Set<string>();

export interface ProductStats {
  revenue: number;
  capital: number;
  linkedExpenses: number;
  // null when any sold line in the period has an unknown purchase cost
  // (v222) — the client renders "—" rather than a fictitious margin.
  profit: number | null;
}

export interface CreateProductData {
  name: string;
  sku?: string | null;
  category?: string | null;
  unit: string;
  cost_price: number;
  sale_price: number;
  reorder_level: number;
  initial_stock: number;
  supplier_id?: string | null;
  purchase_date?: string | null;
  bulk_price?: number | null;
  bulk_min_qty?: number | null;
}

export interface DraftVariant {
  name: string;
  sale_price: number;
  cost_price: number;
  stock_qty: number;
  reorder_level: number;
}

interface ProductStore {
  products: Product[];
  /** Products whose archive call is in flight — their row shows "Archivage…" and ignores taps. */
  archivingIds: string[];
  archivedProducts: Product[];
  variantsByProduct: Record<string, ProductVariant[]>;
  vendeurProductScope: string[];  // product IDs; empty = unscoped (see all)
  // Whether the vendeur's membership has scope_all_products=true. Distinguishes
  // "allowed to sell everything" (flag true) from "restricted but zero products
  // assigned" (flag false + empty scope). Both have an empty scope array, but
  // only the former means "see all" — the latter means "see nothing".
  vendeurScopeAll: boolean;
  // Business id fetchProducts last reached a terminal result for — null
  // until then. See app/(app)/_layout.tsx's showFork gate for why this
  // exists: `products.length === 0` is ambiguous between "confirmed no
  // products" and "haven't loaded yet," and that ambiguity made the
  // activation fork flash on cold start even for a business that already
  // has a product, before this fetch had resolved.
  productsFetchedFor: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  offline: boolean;
  offlineSince: number | null;

  fetchProducts: (businessId: string, userId: string, membershipId?: string, role?: string) => Promise<void>;
  fetchArchivedProducts: (businessId: string) => Promise<void>;
  fetchVariants: (productId: string, businessId: string) => Promise<ProductVariant[]>;
  upsertVariants: (businessId: string, productId: string, userId: string, variants: DraftVariant[]) => Promise<boolean>;
  createProduct: (businessId: string, userId: string, data: CreateProductData) => Promise<boolean>;
  updateProduct: (businessId: string, userId: string, id: string, data: Partial<CreateProductData>) => Promise<boolean>;
  /** true = archived. The caller offers Annuler (restoreProduct) on success. */
  archiveProduct: (id: string, businessId: string) => Promise<boolean>;
  restoreProduct: (id: string, businessId: string, userId: string) => Promise<void>;
  adjustStock: (
    productId: string,
    businessId: string,
    userId: string,
    qty: number,
    type: 'entree' | 'perte',
    note?: string,
  ) => Promise<boolean>;
  fetchProductStats: (productId: string, businessId: string, since?: string) => Promise<ProductStats | null>;
  clearError: () => void;
  reset: () => void;
}


export const useProductStore = create<ProductStore>((set, get) => ({
  products: [],
  archivingIds: [],
  archivedProducts: [],
  variantsByProduct: {},
  vendeurProductScope: [],
  vendeurScopeAll: true,
  productsFetchedFor: null,
  loading: false,
  saving: false,
  error: null,
  offline: false,
  offlineSince: null,

  fetchProducts: async (businessId, userId, membershipId, role) => {
    if (get().products.length === 0) {
      set({ loading: true, error: null });
      const cached = await getProductCache(businessId);
      if (cached && !isStaleBusiness(businessId)) {
        set({ products: cached, loading: false });
      }
    } else {
      set({ error: null });
    }
    try {
      // Security audit 2026-09-27 (1.14, real enforcement): vendeur's own
      // cost_price is never in this response at all — the base products
      // table's SELECT RLS now excludes vendeur outright (migration_v193.sql),
      // so get_products_for_vendeur() is their only actual read path, not
      // just the one this call happens to prefer. Every caller of
      // fetchProducts must pass role for this to actually take effect.
      const { data, error } = await withNetworkRetry(() =>
        role === 'vendeur'
          ? supabase.rpc('get_products_for_vendeur', { p_business_id: businessId })
          : supabase
            .from('products')
            .select('*')
            .eq('business_id', businessId)
            .eq('archived', false)
            .eq('is_system', false)
            .order('name'),
      );

      if (error) throw error;
      if (isStaleBusiness(businessId)) return; // switched away while this was in flight
      const products = (data as Product[]).map(p => ({
        ...p,
        cost_price: p.cost_price / 100,
        sale_price: p.sale_price / 100,
        bulk_price: p.bulk_price != null ? p.bulk_price / 100 : null,
      }));
      set({ products, loading: false, offline: false, offlineSince: null, productsFetchedFor: businessId });
      void saveProductCache(businessId, products);

      // Low-stock detection: notify admins/managers for each product crossing its threshold.
      // Server-side 24h cooldown in dispatch-notification prevents notification floods on restart.
      // Variant parents keep products.stock_qty = 0, so their real signal is on
      // product_variants — handled in the separate variant pass below.
      const lowStock = products.filter(p =>
        !p.has_variants && p.reorder_level > 0 && p.stock_qty <= p.reorder_level && !notifiedLowStockIds.has(p.id),
      );
      lowStock.forEach(p => {
        notifiedLowStockIds.add(p.id);
        notifyEvent({
          businessId,
          eventType: 'low_stock',
          payload: { product: p.name, qty: p.stock_qty, product_id: p.id },
          targetRoles: ['administrateur', 'manager'],
        });
      });

      // Variant low-stock: the parent's stock_qty is always 0, so a variant
      // product crossing its per-variant reorder level was previously never
      // detected at all. Vendeur is excluded — this signal targets
      // admin/manager, and a vendeur's variant read path omits cost fields.
      if (role !== 'vendeur') {
        for (const parent of products.filter(p => p.has_variants)) {
          const variants = await get().fetchVariants(parent.id, businessId);
          if (isStaleBusiness(businessId)) return;
          for (const v of variants) {
            if (!(v.reorder_level > 0 && v.stock_qty <= v.reorder_level)) continue;
            const key = `variant:${v.id}`;
            if (notifiedLowStockIds.has(key)) continue;
            notifiedLowStockIds.add(key);
            notifyEvent({
              businessId,
              eventType: 'low_stock',
              payload: {
                product: parent.name,
                variant: v.name,
                qty: v.stock_qty,
                product_id: parent.id,
                variant_id: v.id,
              },
              targetRoles: ['administrateur', 'manager'],
            });
          }
        }
      }

      // Load vendeur product scope. Fix C(2): read the scope_all_products flag
      // in the same pass, so "allowed to sell everything" (flag true) is no
      // longer conflated with "restricted but zero products assigned" (flag
      // false + empty array — which must show NOTHING, not everything).
      if (role === 'vendeur' && membershipId) {
        const { data: membership } = await supabase
          .from('memberships')
          .select('scope_all_products')
          .eq('id', membershipId)
          .maybeSingle();
        const { data: scopeRows } = await supabase
          .from('membership_product_scope')
          .select('product_id')
          .eq('membership_id', membershipId);
        if (isStaleBusiness(businessId)) return;
        set({
          vendeurScopeAll: (membership as any)?.scope_all_products ?? true,
          vendeurProductScope: (scopeRows ?? []).map((r: any) => r.product_id as string),
        });
      } else {
        set({ vendeurScopeAll: true, vendeurProductScope: [] });
      }
    } catch (err) {
      if (isNetworkError(err)) {
        reportOfflineFallback('products.fetchProducts', err);
        const cached = await getProductCache(businessId);
        if (isStaleBusiness(businessId)) return;
        if (cached) {
          const ts = await getCacheTimestamp('product_cache', businessId);
          if (isStaleBusiness(businessId)) return;
          set({ products: cached, loading: false, offline: true, offlineSince: ts, productsFetchedFor: businessId });
          return;
        }
        set({
          error: 'Pas de connexion. Ouvrez l\'application en ligne une première fois pour activer le mode hors ligne.',
          loading: false,
          offline: true,
          offlineSince: null,
          productsFetchedFor: businessId,
        });
        return;
      }
      if (isStaleBusiness(businessId)) return;
      set({ error: translateError(err, "Le chargement n'a pas abouti."), loading: false, productsFetchedFor: businessId });
    }
  },

  fetchArchivedProducts: async (businessId) => {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('business_id', businessId)
        .eq('archived', true)
        .eq('is_system', false)
        .order('name');

      if (error) throw error;
      if (isStaleBusiness(businessId)) return;
      const archivedProducts = (data as Product[]).map(p => ({
        ...p,
        cost_price: p.cost_price / 100,
        sale_price: p.sale_price / 100,
        bulk_price: p.bulk_price != null ? p.bulk_price / 100 : null,
      }));
      set({ archivedProducts });
    } catch (err) {
      if (isStaleBusiness(businessId)) return;
      set({ error: translateError(err, "Le chargement n'a pas abouti.") });
    }
  },

  createProduct: async (businessId, userId, data) => {
    set({ saving: true, error: null });
    const productId = generateId();
    const productRow = {
      id: productId,
      business_id: businessId,
      name: data.name.trim(),
      sku: data.sku?.trim() || null,
      category: data.category?.trim() || null,
      unit: data.unit,
      cost_price: Math.round(data.cost_price * 100),
      sale_price: Math.round(data.sale_price * 100),
      reorder_level: data.reorder_level,
      stock_qty: data.initial_stock,
      archived: false,
      supplier_id: data.supplier_id || null,
      purchase_date: data.purchase_date || null,
      bulk_price: data.bulk_price ? Math.round(data.bulk_price * 100) : null,
      bulk_min_qty: data.bulk_min_qty || null,
      created_by: userId,
    };
    const stockMoveRow = data.initial_stock > 0 ? {
      id: generateId(),
      business_id: businessId,
      product_id: productId,
      type: 'entree',
      qty: data.initial_stock,
      ref_id: null,
      ref_type: 'initial',
      note: 'Stock initial',
      created_by: userId,
    } : null;

    try {
      const { error: prodErr } = await supabase.rpc('create_product_with_stock', {
        p_product: productRow,
        p_stock_move: stockMoveRow,
      });
      if (prodErr) throw prodErr;
      await get().fetchProducts(businessId, userId);
      trackEvent('product_added', businessId, userId, {
        has_bulk_price: !!(data.bulk_price),
        initial_stock: data.initial_stock,
        has_category: !!(data.category),
      });
      set({ saving: false });
      return true;
    } catch (err) {
      if (isNetworkError(err)) {
        await enqueue('create_product', { product: productRow, stockMove: stockMoveRow });
        const count = await getQueueCount();
        useSyncStore.setState({ pendingCount: count });

        // Optimistically show the new product in-memory and in the cache.
        const optimistic: Product = {
          ...productRow,
          cost_price: data.cost_price,
          sale_price: data.sale_price,
          bulk_price: data.bulk_price ?? null,
          has_variants: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        const updated = [...get().products, optimistic].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
        set({ products: updated, saving: false });
        void saveProductCache(businessId, updated);
        return true;
      }
      set({ error: translateError(err, 'Erreur de création'), saving: false });
      return false;
    }
  },

  updateProduct: async (businessId, userId, id, data) => {
    set({ saving: true, error: null });
    const oldProduct = get().products.find(p => p.id === id);
    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.name = data.name.trim();
    if (data.sku !== undefined) patch.sku = data.sku?.trim() || null;
    if (data.category !== undefined) patch.category = data.category?.trim() || null;
    if (data.unit !== undefined) patch.unit = data.unit;
    if (data.cost_price !== undefined) patch.cost_price = Math.round(data.cost_price * 100);
    if (data.sale_price !== undefined) patch.sale_price = Math.round(data.sale_price * 100);
    if (data.reorder_level !== undefined) patch.reorder_level = data.reorder_level;
    if (data.supplier_id !== undefined) patch.supplier_id = data.supplier_id || null;
    if (data.purchase_date !== undefined) patch.purchase_date = data.purchase_date || null;
    if (data.bulk_price !== undefined) patch.bulk_price = data.bulk_price ? Math.round(data.bulk_price * 100) : null;
    if (data.bulk_min_qty !== undefined) patch.bulk_min_qty = data.bulk_min_qty || null;

    try {
      const { error } = await supabase.from('products').update(patch).eq('id', id);
      if (error) throw error;
      await get().fetchProducts(businessId, userId);
      set({ saving: false });

      // Catalogue price edits are admin/manager-only, but a manager quietly
      // lowering a price (or a genuine typo) has had no visibility to anyone
      // else until now — notify the rest of admin/manager the same way a sale
      // correction already does (stores/ventes.ts's sale_edited), so this
      // isn't a silent edit anymore. Only the live-success path notifies —
      // an offline-queued edit has no reliable "later" moment to fire from.
      if (
        patch.sale_price !== undefined &&
        oldProduct &&
        Math.round(oldProduct.sale_price * 100) !== patch.sale_price
      ) {
        const currency = useAuthStore.getState().session?.activeBusiness?.currency ?? 'GNF';
        const editorName = useAuthStore.getState().session?.user?.name || generateFallbackName(userId);
        notifyEvent({
          businessId,
          eventType: 'price_changed',
          payload: {
            editor: editorName,
            product: oldProduct.name,
            old_price: formatAmount(oldProduct.sale_price, currency),
            new_price: formatAmount((patch.sale_price as number) / 100, currency),
          },
          targetRoles: ['administrateur', 'manager'],
          excludeUserId: userId,
        });
      }

      return true;
    } catch (err) {
      if (isNetworkError(err)) {
        await enqueue('update_product', { id, ...patch });
        const count = await getQueueCount();
        useSyncStore.setState({ pendingCount: count });

        // Optimistic in-memory patch. Prices are stored as cents in the DB but as
        // whole units in the store, so convert back before patching the store.
        const displayPatch: Partial<Product> = { ...patch } as Partial<Product>;
        if (patch.cost_price !== undefined) displayPatch.cost_price = (patch.cost_price as number) / 100;
        if (patch.sale_price !== undefined) displayPatch.sale_price = (patch.sale_price as number) / 100;
        if (patch.bulk_price !== undefined) displayPatch.bulk_price = patch.bulk_price != null ? (patch.bulk_price as number) / 100 : null;

        const updated = get().products.map(p => p.id === id ? { ...p, ...displayPatch } : p);
        set({ products: updated, saving: false });
        void saveProductCache(businessId, updated);
        return true;
      }
      set({ error: translateError(err, 'Erreur de mise à jour'), saving: false });
      return false;
    }
  },

  archiveProduct: (id, businessId) =>
    archiveGuard.run(id, async () => {
    set(state => ({ archivingIds: [...state.archivingIds, id] }));
    try {
      const { error } = await supabase.from('products').update({ archived: true }).eq('id', id);
      if (error) throw error;
      set(state => ({ products: state.products.filter(p => p.id !== id) }));
      return true;
    } catch (err) {
      set({ error: translateError(err, "Impossible d'archiver le produit") });
      return false;
    } finally {
      set(state => ({ archivingIds: state.archivingIds.filter(x => x !== id) }));
    }
  }).then(r => (r.ran ? r.value : false)),

  restoreProduct: async (id, businessId, userId) => {
    try {
      const { error } = await supabase.from('products').update({ archived: false }).eq('id', id);
      if (error) throw error;
      set(state => ({ archivedProducts: state.archivedProducts.filter(p => p.id !== id) }));
      await get().fetchProducts(businessId, userId);
    } catch (err) {
      set({ error: translateError(err, 'Erreur de restauration') });
    }
  },

  adjustStock: async (productId, businessId, userId, qty, type, note) => {
    set({ saving: true, error: null });
    const product = get().products.find(p => p.id === productId);
    const delta = type === 'entree' ? Math.abs(qty) : -Math.abs(qty);
    const newQty = product ? Math.max(0, product.stock_qty + delta) : Math.abs(qty);

    const stockMoveRow = {
      id: generateId(),
      business_id: businessId,
      product_id: productId,
      type,
      qty: Math.abs(qty),
      ref_id: null,
      ref_type: 'manuel',
      note: note || null,
      created_by: userId,
    };

    try {
      const { error: moveErr } = await supabase.from('stock_moves').insert(stockMoveRow);
      if (moveErr) throw moveErr;
      await supabase.from('products').update({ stock_qty: newQty }).eq('id', productId);
      set(state => ({
        products: state.products.map(p => (p.id === productId ? { ...p, stock_qty: newQty } : p)),
        saving: false,
      }));
      const updated = get().products;
      void saveProductCache(businessId, updated);
      return true;
    } catch (err) {
      if (isNetworkError(err)) {
        await enqueue('adjust_stock', {
          stockMove: stockMoveRow,
          productUpdate: { id: productId, stock_qty: newQty },
        });
        const count = await getQueueCount();
        useSyncStore.setState({ pendingCount: count });

        // Optimistic in-memory and cache update.
        const optimisticProducts = get().products.map(p =>
          p.id === productId ? { ...p, stock_qty: newQty } : p,
        );
        set({ products: optimisticProducts, saving: false });
        void saveProductCache(businessId, optimisticProducts);
        return true;
      }
      set({ error: translateError(err, "Erreur d'ajustement"), saving: false });
      return false;
    }
  },

  fetchVariants: async (productId, businessId) => {
    // Security audit 2026-09-27 (1.14, real enforcement): a vendeur's own
    // cost_price is never in the response at all for this role — the base
    // table's SELECT RLS now excludes vendeur outright, so this is their
    // only actual read path, not just the one the app happens to prefer.
    // Role read from the session directly rather than added as a param —
    // this function has 6 call sites and none of them need to change.
    const role = useAuthStore.getState().session?.activeMembership?.role;
    let data: unknown = null;
    let error: unknown = null;
    try {
      const res = await withNetworkRetry(() => role === 'vendeur'
        ? supabase.rpc('get_variants_for_vendeur', { p_product_id: productId, p_business_id: businessId })
        : supabase
          .from('product_variants')
          .select('*')
          .eq('product_id', productId)
          .eq('business_id', businessId)
          .eq('archived', false)
          .order('name'));
      data = res.data;
      error = res.error;
    } catch (err) {
      error = err;
    }
    if (error || !data) {
      // Offline (or a failed fetch): fall back to the last known variant
      // stock so a variant sale is capped by it, same as a plain product.
      // No cache → [] as before (nothing to sell against).
      if (isNetworkError(error)) {
        const cached = await getVariantsCache(businessId, productId) as ProductVariant[] | null;
        if (cached && cached.length) {
          set(state => ({ variantsByProduct: { ...state.variantsByProduct, [productId]: cached } }));
          return cached;
        }
      }
      return [];
    }
    const variants: ProductVariant[] = (data as ProductVariant[]).map(v => ({
      ...v,
      sale_price: v.sale_price / 100,
      cost_price: v.cost_price / 100,
    }));
    void saveVariantsCache(businessId, productId, variants);
    set(state => ({ variantsByProduct: { ...state.variantsByProduct, [productId]: variants } }));
    return variants;
  },

  upsertVariants: async (businessId, productId, userId, variants) => {
    set({ saving: true, error: null });
    // upsert_product_variants deletes every existing row and reinserts fresh
    // ones (see migration_v65.sql) — variant ids never survive a save, so a
    // before/after diff for the price-change notification below has to match
    // on name, the only identifier that does survive.
    const oldByName = new Map(
      (get().variantsByProduct[productId] ?? []).map(v => [v.name, v]),
    );
    try {
      const payload = variants.map(v => ({
        name: v.name.trim(),
        sale_price: Math.round(v.sale_price * 100),
        cost_price: Math.round(v.cost_price * 100),
        stock_qty: v.stock_qty,
        reorder_level: v.reorder_level,
      }));
      const { error } = await supabase.rpc('upsert_product_variants', {
        p_business_id: businessId,
        p_product_id: productId,
        p_variants: payload,
      });
      if (error) throw error;
      await get().fetchProducts(businessId, userId);
      await get().fetchVariants(productId, businessId);
      set({ saving: false });

      const product = get().products.find(p => p.id === productId);
      if (product) {
        const currency = useAuthStore.getState().session?.activeBusiness?.currency ?? 'GNF';
        const editorName = useAuthStore.getState().session?.user?.name || generateFallbackName(userId);
        for (const row of payload) {
          const old = oldByName.get(row.name);
          if (old && Math.round(old.sale_price * 100) !== row.sale_price) {
            notifyEvent({
              businessId,
              eventType: 'price_changed',
              payload: {
                editor: editorName,
                product: product.name,
                variant: row.name,
                old_price: formatAmount(old.sale_price, currency),
                new_price: formatAmount(row.sale_price / 100, currency),
              },
              targetRoles: ['administrateur', 'manager'],
              excludeUserId: userId,
            });
          }
        }
      }

      return true;
    } catch (err) {
      set({ error: translateError(err, 'Erreur de mise à jour'), saving: false });
      return false;
    }
  },

  fetchProductStats: async (productId, businessId, since) => {
    const { data, error } = await supabase.rpc('get_product_stats', {
      p_product_id: productId,
      p_business_id: businessId,
      p_since: since ?? null,
    });
    if (error || !data) return null;
    const d = data as any;
    return {
      revenue: d.revenue / 100,
      capital: d.capital / 100,
      linkedExpenses: d.linked_expenses / 100,
      // v222 returns NULL when profit is untrustworthy — keep it null so the
      // catalogue sheet renders "—" instead of a fabricated margin.
      profit: d.profit == null ? null : d.profit / 100,
    };
  },

  clearError: () => set({ error: null }),
  reset: () => {
    notifiedLowStockIds.clear();
    set({ products: [], archivingIds: [], archivedProducts: [], variantsByProduct: {}, vendeurProductScope: [], vendeurScopeAll: true, productsFetchedFor: null, loading: false, error: null, offline: false, offlineSince: null });
  },
}));
