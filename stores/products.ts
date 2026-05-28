import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { generateId } from '@/lib/id';
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

  fetchProducts: async (businessId, userId) => {
    set({ loading: true, error: null });
    try {
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('business_id', businessId)
        .eq('archived', false)
        .order('name');

      if (error) throw error;
      set({ products: (data as Product[]) ?? [], loading: false });
    } catch (err) {
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
      set({ archivedProducts: (data as Product[]) ?? [] });
    } catch (err) {
      set({ error: translateError(err, 'Erreur de chargement') });
    }
  },

  createProduct: async (businessId, userId, data) => {
    set({ saving: true, error: null });
    try {
      const productId = generateId();
      const { error: prodErr } = await supabase.from('products').insert({
        id: productId,
        business_id: businessId,
        name: data.name.trim(),
        sku: data.sku?.trim() || null,
        category: data.category?.trim() || null,
        unit: data.unit,
        cost_price: data.cost_price,
        sale_price: data.sale_price,
        reorder_level: data.reorder_level,
        stock_qty: data.initial_stock,
        archived: false,
        supplier_id: data.supplier_id || null,
        purchase_date: data.purchase_date || null,
        bulk_price: data.bulk_price || null,
        bulk_min_qty: data.bulk_min_qty || null,
        created_by: userId,
      });
      if (prodErr) throw prodErr;

      if (data.initial_stock > 0) {
        await supabase.from('stock_moves').insert({
          id: generateId(),
          business_id: businessId,
          product_id: productId,
          type: 'entree',
          qty: data.initial_stock,
          ref_id: null,
          ref_type: 'initial',
          note: 'Stock initial',
          created_by: userId,
        });
      }

      await get().fetchProducts(businessId, userId);
      set({ saving: false });
      return true;
    } catch (err) {
      set({ error: translateError(err, 'Erreur de création'), saving: false });
      return false;
    }
  },

  updateProduct: async (businessId, userId, id, data) => {
    set({ saving: true, error: null });
    try {
      const patch: Record<string, unknown> = {};
      if (data.name !== undefined) patch.name = data.name.trim();
      if (data.sku !== undefined) patch.sku = data.sku?.trim() || null;
      if (data.category !== undefined) patch.category = data.category?.trim() || null;
      if (data.unit !== undefined) patch.unit = data.unit;
      if (data.cost_price !== undefined) patch.cost_price = data.cost_price;
      if (data.sale_price !== undefined) patch.sale_price = data.sale_price;
      if (data.reorder_level !== undefined) patch.reorder_level = data.reorder_level;
      if (data.supplier_id !== undefined) patch.supplier_id = data.supplier_id || null;
      if (data.purchase_date !== undefined) patch.purchase_date = data.purchase_date || null;
      if (data.bulk_price !== undefined) patch.bulk_price = data.bulk_price || null;
      if (data.bulk_min_qty !== undefined) patch.bulk_min_qty = data.bulk_min_qty || null;

      const { error } = await supabase.from('products').update(patch).eq('id', id);
      if (error) throw error;
      await get().fetchProducts(businessId, userId);
      set({ saving: false });
      return true;
    } catch (err) {
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
    try {
      const { error: moveErr } = await supabase.from('stock_moves').insert({
        id: generateId(),
        business_id: businessId,
        product_id: productId,
        type,
        qty: Math.abs(qty),
        ref_id: null,
        ref_type: 'manuel',
        note: note || null,
        created_by: userId,
      });
      if (moveErr) throw moveErr;

      const product = get().products.find(p => p.id === productId);
      if (product) {
        const delta = type === 'entree' ? Math.abs(qty) : -Math.abs(qty);
        const newQty = Math.max(0, product.stock_qty + delta);
        await supabase.from('products').update({ stock_qty: newQty }).eq('id', productId);
        set(state => ({
          products: state.products.map(p => (p.id === productId ? { ...p, stock_qty: newQty } : p)),
          saving: false,
        }));
      } else {
        await get().fetchProducts(businessId, userId);
        set({ saving: false });
      }
    } catch (err) {
      set({ error: translateError(err, "Erreur d'ajustement"), saving: false });
    }
  },

  clearError: () => set({ error: null }),
  reset: () => set({ products: [], archivedProducts: [], loading: false, error: null }),
}));
