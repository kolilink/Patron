import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import type { PaymentMethod, Product } from '@/src/types';

function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export interface CartLine {
  product: Product;
  qty: number;
  unit_price: number;
  is_bulk: boolean;
}

export interface SalePayment {
  method: PaymentMethod;
  amount: number;
  ref_external?: string | null;
}

interface SalesStore {
  cart: CartLine[];
  submitting: boolean;
  error: string | null;

  addToCart: (product: Product, bulk?: boolean) => void;
  removeFromCart: (productId: string, isBulk?: boolean) => void;
  setQty: (productId: string, qty: number, isBulk?: boolean) => void;
  toggleBulk: (productId: string, isBulk?: boolean) => void;
  clearCart: () => void;
  submitSale: (
    businessId: string,
    userId: string,
    payment: SalePayment,
    customerName?: string,
    saleDate?: string,
  ) => Promise<boolean>;
  clearError: () => void;
}

export const useSalesStore = create<SalesStore>((set, get) => ({
  cart: [],
  submitting: false,
  error: null,

  addToCart: (product, bulk = false) => {
    const { cart } = get();
    const existing = cart.find(l => l.product.id === product.id && l.is_bulk === bulk);
    if (existing) {
      set({
        cart: cart.map(l =>
          l.product.id === product.id && l.is_bulk === bulk ? { ...l, qty: l.qty + 1 } : l,
        ),
      });
    } else {
      const unit_price = bulk && product.bulk_price ? product.bulk_price : product.sale_price;
      set({ cart: [...cart, { product, qty: 1, unit_price, is_bulk: bulk }] });
    }
  },

  removeFromCart: (productId, isBulk) => {
    set(state => ({
      cart: state.cart.filter(l =>
        !(l.product.id === productId && (isBulk === undefined || l.is_bulk === isBulk))
      ),
    }));
  },

  setQty: (productId, qty, isBulk) => {
    if (qty <= 0) {
      get().removeFromCart(productId, isBulk);
      return;
    }
    set(state => ({
      cart: state.cart.map(l =>
        l.product.id === productId && (isBulk === undefined || l.is_bulk === isBulk)
          ? { ...l, qty }
          : l
      ),
    }));
  },

  toggleBulk: (productId, currentIsBulk) => {
    const { cart } = get();
    const targetLine = cart.find(l => l.product.id === productId && l.is_bulk === currentIsBulk);
    if (!targetLine) return;
    const newBulk = !currentIsBulk;
    const unit_price = newBulk && targetLine.product.bulk_price ? targetLine.product.bulk_price : targetLine.product.sale_price;
    const existingTarget = cart.find(l => l.product.id === productId && l.is_bulk === newBulk);
    if (existingTarget) {
      // Merge into existing line, remove toggled line
      set({
        cart: cart
          .filter(l => !(l.product.id === productId && l.is_bulk === currentIsBulk))
          .map(l =>
            l.product.id === productId && l.is_bulk === newBulk
              ? { ...l, qty: l.qty + targetLine.qty }
              : l
          ),
      });
    } else {
      set({
        cart: cart.map(l =>
          l.product.id === productId && l.is_bulk === currentIsBulk
            ? { ...l, is_bulk: newBulk, unit_price }
            : l
        ),
      });
    }
  },

  clearCart: () => set({ cart: [] }),

  submitSale: async (businessId, userId, payment, customerName, saleDate) => {
    const { cart } = get();
    if (cart.length === 0) return false;

    set({ submitting: true, error: null });
    try {
      const orderId = generateId();
      const totalAmount = cart.reduce((sum, l) => sum + l.unit_price * l.qty, 0);
      const isPaid = payment.method !== 'credit';
      const today = new Date().toISOString().split('T')[0];

      const { error: orderErr } = await supabase.from('sale_orders').insert({
        id: orderId,
        business_id: businessId,
        customer_name: customerName?.trim() || null,
        seller_id: userId,
        status: isPaid ? 'paye' : 'credit',
        paid_at: isPaid ? new Date().toISOString() : null,
        sale_date: saleDate || today,
        total_amount: totalAmount,
        created_by: userId,
      });
      if (orderErr) throw orderErr;

      const soLines = cart.map(l => ({
        id: generateId(),
        order_id: orderId,
        product_id: l.product.id,
        qty: l.qty,
        unit_price: l.unit_price,
        is_bulk: l.is_bulk,
      }));
      const { error: linesErr } = await supabase.from('so_lines').insert(soLines);
      if (linesErr) throw linesErr;

      const { error: payErr } = await supabase.from('payments').insert({
        id: generateId(),
        order_id: orderId,
        method: payment.method,
        amount: payment.amount,
        ref_external: payment.ref_external || null,
      });
      if (payErr) throw payErr;

      const stockMoves = cart.map(l => ({
        id: generateId(),
        business_id: businessId,
        product_id: l.product.id,
        type: 'sortie',
        qty: l.qty,
        ref_id: orderId,
        ref_type: 'sale_order',
        note: null,
        created_by: userId,
      }));
      const { error: movesErr } = await supabase.from('stock_moves').insert(stockMoves);
      if (movesErr) throw movesErr;

      for (const l of cart) {
        const newQty = Math.max(0, l.product.stock_qty - l.qty);
        await supabase.from('products').update({ stock_qty: newQty }).eq('id', l.product.id);
      }

      set({ cart: [], submitting: false });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur lors de la vente';
      set({ error: msg, submitting: false });
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));
