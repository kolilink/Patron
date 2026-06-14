import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { generateId } from '@/lib/id';
import { saveProductCache, getProductCache, enqueue, getQueueCount, getCacheTimestamp } from '@/lib/db';
import { isNetworkError } from '@/lib/sync';
import { useSyncStore } from '@/stores/sync';
import type { Product } from '@/src/types';

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

interface ProductStore {
  products: Product[];
  archivedProducts: Product[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  offline: boolean;
  offlineSince: number | null;

  fetchProducts: (businessId: string, userId: string) => Promise<void>;
  fetchArchivedProducts: (businessId: string) => Promise<void>;
  createProduct: (businessId: string, userId: string, data: CreateProductData) => Promise<boolean>;
  updateProduct: (businessId: string, userId: string, id: string, data: Partial<CreateProductData>) => Promise<boolean>;
  archiveProduct: (id: string, businessId: string) => Promise<void>;
  restoreProduct: (id: string, businessId: string, userId: string) => Promise<void>;
  adjustStock: (
    productId: string,
    businessId: string,
    userId: string,
    qty: number,
    type: 'entree' | 'perte',
    note?: string,
  ) => Promise<void>;
  clearError: () => void;
  reset: () => void;
}


export const useProductStore = create<ProductStore>((set, get) => ({
  products: [],
  archivedProducts: [],
  loading: false,
  saving: false,
  error: null,
  offline: false,
  offlineSince: null,

  fetchProducts: async (businessId, userId) => {
    if (get().products.length === 0) {
      const cached = await getProductCache(businessId);
      if (cached) {
        set({ products: cached, loading: false, error: null });
      } else {
        set({ loading: true, error: null });
      }
    } else {
      set({ error: null });
    }
    try {
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('business_id', businessId)
        .eq('archived', false)
        .order('name');

      if (error) throw error;
      const products = (data as Product[]).map(p => ({
        ...p,
        cost_price: p.cost_price / 100,
        sale_price: p.sale_price / 100,
        bulk_price: p.bulk_price != null ? p.bulk_price / 100 : null,
      }));
      set({ products, loading: false, offline: false, offlineSince: null });
      void saveProductCache(businessId, products);
    } catch (err) {
      if (isNetworkError(err)) {
        const cached = await getProductCache(businessId);
        if (cached) {
          const ts = await getCacheTimestamp('product_cache', businessId);
          set({ products: cached, loading: false, offline: true, offlineSince: ts });
          return;
        }
        set({
          error: 'Pas de connexion. Ouvrez l\'application en ligne une première fois pour activer le mode hors ligne.',
          loading: false,
          offline: false,
        });
        return;
      }
      set({ error: translateError(err, 'Erreur de chargement'), loading: false });
    }
  },

  fetchArchivedProducts: async (businessId) => {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('business_id', businessId)
        .eq('archived', true)
        .order('name');

      if (error) throw error;
      const archivedProducts = (data as Product[]).map(p => ({
        ...p,
        cost_price: p.cost_price / 100,
        sale_price: p.sale_price / 100,
        bulk_price: p.bulk_price != null ? p.bulk_price / 100 : null,
      }));
      set({ archivedProducts });
    } catch (err) {
      set({ error: translateError(err, 'Erreur de chargement') });
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

  archiveProduct: async (id, businessId) => {
    try {
      const { error } = await supabase.from('products').update({ archived: true }).eq('id', id);
      if (error) throw error;
      set(state => ({ products: state.products.filter(p => p.id !== id) }));
    } catch (err) {
      set({ error: translateError(err, "Impossible d'archiver le produit") });
    }
  },

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
        return;
      }
      set({ error: translateError(err, "Erreur d'ajustement"), saving: false });
    }
  },

  clearError: () => set({ error: null }),
  reset: () => set({ products: [], archivedProducts: [], loading: false, error: null, offline: false, offlineSince: null }),
}));
