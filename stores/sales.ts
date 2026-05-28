import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { enqueue, getQueueCount } from '@/lib/db';
import { isNetworkError } from '@/lib/sync';
import { useSyncStore } from '@/stores/sync';
import type { PaymentMethod, Product } from '@/src/types';

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
  lastSubmitQueued: boolean;

  addToCart: (product: Product, bulk?: boolean) => void;
  removeFromCart: (productId: string, isBulk?: boolean) => void;
  setQty: (productId: string, qty: number, isBulk?: boolean) => void;
  toggleBulk: (productId: string, isBulk?: boolean) => void;
  clearCart: () => void;
  submitSale: (
    businessId: string,
    userId: string,
    payment: SalePayment | null,
    customerName?: string,
    saleDate?: string,
    discountAmount?: number,
  ) => Promise<boolean>;
  clearError: () => void;
  reset: () => void;
}

export const useSalesStore = create<SalesStore>((set, get) => ({
  cart: [],
  submitting: false,
  error: null,
  lastSubmitQueued: false,

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

  submitSale: async (businessId, userId, payment, customerName, saleDate, discountAmount) => {
    const { cart } = get();
    if (cart.length === 0) return false;

    const cartSnapshot = [...cart];
    set({ submitting: true, error: null });

    try {
      const totalAmount = cartSnapshot.reduce((sum, l) => sum + l.unit_price * l.qty, 0);
      const isFullCredit = payment === null;
      const discount = discountAmount ?? 0;
      const isPartialCredit = !isFullCredit && discount === 0 && payment!.amount < totalAmount - 0.01;
      const isCredit = isFullCredit || isPartialCredit;
      const today = new Date().toISOString().split('T')[0];

      const cartJson = cartSnapshot.map(l => ({
        product_id: l.product.id,
        qty: l.qty,
        unit_price: l.unit_price,
        is_bulk: l.is_bulk,
      }));

      const rpcPayload = {
        p_business_id:     businessId,
        p_seller_id:       userId,
        p_customer_name:   customerName?.trim() || null,
        p_sale_date:       saleDate || today,
        p_total_amount:    totalAmount,
        p_discount_amount: discount,
        p_is_credit:       isCredit,
        p_cart:            cartJson,
        p_pay_method:      payment?.method  ?? null,
        p_pay_amount:      payment?.amount  ?? null,
        p_pay_ref:         payment?.ref_external ?? null,
      };

      const { error: rpcErr } = await supabase.rpc('submit_sale', rpcPayload);
      if (rpcErr) throw rpcErr;

      set({ cart: [], submitting: false, lastSubmitQueued: false });
      return true;
    } catch (err) {
      if (isNetworkError(err)) {
        const totalAmount = cartSnapshot.reduce((sum, l) => sum + l.unit_price * l.qty, 0);
        const isFullCredit = payment === null;
        const discount = discountAmount ?? 0;
        const isPartialCredit = !isFullCredit && discount === 0 && payment!.amount < totalAmount - 0.01;
        const isCredit = isFullCredit || isPartialCredit;
        const today = new Date().toISOString().split('T')[0];

        await enqueue('submit_sale', {
          p_business_id:     businessId,
          p_seller_id:       userId,
          p_customer_name:   customerName?.trim() || null,
          p_sale_date:       saleDate || today,
          p_total_amount:    totalAmount,
          p_discount_amount: discount,
          p_is_credit:       isCredit,
          p_cart:            cartSnapshot.map(l => ({
            product_id: l.product.id,
            qty: l.qty,
            unit_price: l.unit_price,
            is_bulk: l.is_bulk,
          })),
          p_pay_method:      payment?.method  ?? null,
          p_pay_amount:      payment?.amount  ?? null,
          p_pay_ref:         payment?.ref_external ?? null,
        });

        const count = await getQueueCount();
        useSyncStore.setState({ pendingCount: count });

        set({ cart: [], submitting: false, lastSubmitQueued: true });
        return true;
      }
      const raw = err instanceof Error ? err.message : JSON.stringify(err);
      set({ error: raw, submitting: false, lastSubmitQueued: false });
      return false;
    }
  },

  clearError: () => set({ error: null }),
  reset: () => set({ cart: [], submitting: false, error: null, lastSubmitQueued: false }),
}));
