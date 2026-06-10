import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { enqueue, getQueueCount, saveProductCache, getProductCache, saveVentesCache, getVentesCache } from '@/lib/db';
import { isNetworkError } from '@/lib/sync';
import { generateId } from '@/lib/id';
import { useSyncStore } from '@/stores/sync';
import { useVentesStore } from '@/stores/ventes';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import { trackEvent } from '@/lib/analytics';
import { haptics } from '@/lib/haptics';
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
    clientId?: string | null,
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

  submitSale: async (businessId, userId, payment, customerName, saleDate, discountAmount, clientId) => {
    const { cart } = get();
    if (cart.length === 0) return false;

    const cartSnapshot = [...cart];
    const idempotencyKey = generateId();
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
        unit_price: Math.round(l.unit_price * 100),
        is_bulk: l.is_bulk,
      }));

      const rpcPayload = {
        p_business_id:      businessId,
        p_seller_id:        userId,
        p_customer_name:    customerName?.trim() || null,
        p_sale_date:        saleDate || today,
        p_total_amount:     Math.round(totalAmount * 100),
        p_discount_amount:  Math.round(discount * 100),
        p_is_credit:        isCredit,
        p_cart:             cartJson,
        p_pay_method:       payment?.method  ?? null,
        p_pay_amount:       payment?.amount  != null ? Math.round(payment.amount * 100) : null,
        p_pay_ref:          payment?.ref_external ?? null,
        p_idempotency_key:  idempotencyKey,
        p_client_id:        clientId ?? null,
      };

      const { error: rpcErr } = await supabase.rpc('submit_sale', rpcPayload);
      if (rpcErr) throw rpcErr;

      set({ cart: [], submitting: false, lastSubmitQueued: false });
      haptics.success();
      trackEvent('sale_submitted', businessId, userId, {
        is_credit: isCredit,
        items_count: cartSnapshot.length,
      });
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
          p_total_amount:    Math.round(totalAmount * 100),
          p_discount_amount: Math.round(discount * 100),
          p_is_credit:       isCredit,
          p_cart:            cartSnapshot.map(l => ({
            product_id: l.product.id,
            qty: l.qty,
            unit_price: Math.round(l.unit_price * 100),
            is_bulk: l.is_bulk,
          })),
          p_pay_method:      payment?.method  ?? null,
          p_pay_amount:      payment?.amount  != null ? Math.round(payment.amount * 100) : null,
          p_pay_ref:         payment?.ref_external ?? null,
          p_idempotency_key: idempotencyKey,
          p_client_id:       clientId ?? null,
        });

        const count = await getQueueCount();
        useSyncStore.setState({ pendingCount: count });

        set({ cart: [], submitting: false, lastSubmitQueued: true });
        haptics.success();
        trackEvent('sale_offline_queued', businessId, userId, {
          items_count: cartSnapshot.length,
        });

        // Optimistically decrement stock in both the local product cache and the
        // in-memory Zustand store so the POS reflects updated quantities immediately.
        void (async () => {
          const cached = await getProductCache(businessId);
          const base = cached ?? useProductStore.getState().products;
          if (!base.length) return;
          const updated = base.map(p => {
            const line = cartSnapshot.find(l => l.product.id === p.id);
            if (!line) return p;
            return { ...p, stock_qty: Math.max(0, p.stock_qty - line.qty) };
          });
          useProductStore.setState({ products: updated });
          await saveProductCache(businessId, updated);
        })();

        // Optimistically add this sale to the ventes store so credits, sales
        // history, and home screen totals reflect it immediately while offline.
        void (async () => {
          const sellerName = useAuthStore.getState().session?.user.name ?? '';
          const now = new Date().toISOString();
          const optimisticSale = {
            id: idempotencyKey,
            business_id: businessId,
            customer_name: customerName?.trim() || null,
            client_id: clientId ?? null,
            seller_id: userId,
            seller_name: sellerName,
            status: isCredit ? 'credit' : 'paye',
            is_credit: isCredit,
            total_amount: totalAmount,
            discount_amount: discount,
            amount_paid: payment?.amount ?? 0,
            paid_at: isCredit ? null : now,
            sale_date: saleDate || today,
            created_at: now,
            cancelled_at: null,
            cancellation_reason: null,
            profit: null,
            lines: cartSnapshot.map(l => ({
              id: generateId(),
              product_id: l.product.id,
              product_name: l.product.name,
              qty: l.qty,
              unit_price: l.unit_price,
              is_bulk: l.is_bulk,
              cost_price: l.product.cost_price ?? 0,
            })),
            payments: payment ? [{
              id: generateId(),
              method: payment.method,
              amount: payment.amount,
              date: now,
            }] : [],
          };

          const ventesStore = useVentesStore.getState();
          const updatedSales = [optimisticSale, ...ventesStore.sales];
          useVentesStore.setState({ sales: updatedSales });

          // Update each cache key independently to avoid overwriting a different
          // user's filtered view with this seller's subset of sales.
          await saveVentesCache(`${businessId}:${userId}`, updatedSales as unknown[]);

          // For the all-sales cache, load it and prepend — don't overwrite it with
          // only this seller's sales, which would strip every other seller's rows.
          const allCached = await getVentesCache(`${businessId}:all`) ?? [];
          await saveVentesCache(`${businessId}:all`, [optimisticSale, ...allCached] as unknown[]);
        })();

        return true;
      }
      const raw = err instanceof Error ? err.message : JSON.stringify(err);
      haptics.error();
      set({ error: raw, submitting: false, lastSubmitQueued: false });
      return false;
    }
  },

  clearError: () => set({ error: null }),
  reset: () => set({ cart: [], submitting: false, error: null, lastSubmitQueued: false }),
}));
