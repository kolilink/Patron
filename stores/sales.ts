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
import { useToastStore } from '@/stores/toast';
import { notifyEvent } from '@/src/utils/notifications';
import { formatAmount } from '@/src/utils/format';
import type { PaymentMethod, Product, ProductVariant } from '@/src/types';

export interface CartLine {
  product: Product;
  qty: number;
  unit_price: number;
  is_bulk: boolean;
  variant_id?: string;
  variant_name?: string;
  variant_cost_price?: number;
  variant_stock_qty?: number;
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
  addToCartVariant: (product: Product, variant: ProductVariant, qty?: number) => void;
  removeFromCart: (productId: string, isBulk?: boolean, variantId?: string) => void;
  setQty: (productId: string, qty: number, isBulk?: boolean, variantId?: string) => void;
  toggleBulk: (productId: string, isBulk?: boolean) => void;
  clearCart: () => void;
  submitCarnetDebt: (businessId: string, userId: string, customerName: string, amountCents: number) => Promise<boolean>;
  submitSale: (
    businessId: string,
    userId: string,
    payment: SalePayment | null,
    customerName?: string,
    saleDate?: string,
    discountAmount?: number,
    clientId?: string | null,
    overrideTotalAmount?: number,
    dueDate?: string | null,
  ) => Promise<boolean>;
  clearError: () => void;
  reset: () => void;
}

// Builds the "{qty} {product}" fragment for the sale-completed notification.
// Groups by base product_id: a single product (even split across variant
// lines) is named directly; 2+ distinct products fall back to a generic count.
function describeSaleForNotification(lines: CartLine[]): string {
  const byProduct = new Map<string, CartLine[]>();
  for (const l of lines) {
    const group = byProduct.get(l.product.id);
    if (group) group.push(l);
    else byProduct.set(l.product.id, [l]);
  }

  const totalQty = lines.reduce((s, l) => s + l.qty, 0);

  if (byProduct.size > 1) {
    return `${totalQty} produits`;
  }

  const group = byProduct.values().next().value!;
  const productName = group[0].product.name;
  if (group.length === 1 && group[0].variant_name) {
    return `${totalQty} ${productName} ${group[0].variant_name}`;
  }
  return `${totalQty} ${productName}`;
}

export const useSalesStore = create<SalesStore>((set, get) => ({
  cart: [],
  submitting: false,
  error: null,
  lastSubmitQueued: false,

  addToCart: (product, bulk = false) => {
    const { cart } = get();
    // Bulk and unit lines for the same product share one physical stock pool —
    // cap the combined total at stock_qty so tapping the tile repeatedly can
    // never reserve more than what's actually left to sell.
    const totalInCart = cart
      .filter(l => l.product.id === product.id && !l.variant_id)
      .reduce((s, l) => s + l.qty, 0);
    if (totalInCart >= product.stock_qty) return;

    const existing = cart.find(l => l.product.id === product.id && l.is_bulk === bulk && !l.variant_id);
    if (existing) {
      set({
        cart: cart.map(l =>
          l.product.id === product.id && l.is_bulk === bulk && !l.variant_id ? { ...l, qty: l.qty + 1 } : l,
        ),
      });
    } else {
      const unit_price = bulk && product.bulk_price ? product.bulk_price : product.sale_price;
      set({ cart: [...cart, { product, qty: 1, unit_price, is_bulk: bulk }] });
    }
  },

  addToCartVariant: (product, variant, qty = 1) => {
    const { cart } = get();
    const existing = cart.find(l => l.variant_id === variant.id);
    if (existing) {
      set({
        cart: cart.map(l =>
          l.variant_id === variant.id
            ? { ...l, qty: Math.min(l.qty + qty, variant.stock_qty) }
            : l,
        ),
      });
    } else {
      set({ cart: [...cart, {
        product,
        qty: Math.min(qty, variant.stock_qty),
        unit_price: variant.sale_price,
        is_bulk: false,
        variant_id: variant.id,
        variant_name: variant.name,
        variant_cost_price: variant.cost_price,
        variant_stock_qty: variant.stock_qty,
      }] });
    }
  },

  removeFromCart: (productId, isBulk, variantId) => {
    set(state => ({
      cart: state.cart.filter(l => {
        if (variantId !== undefined) return l.variant_id !== variantId;
        return !(l.product.id === productId && (isBulk === undefined || l.is_bulk === isBulk));
      }),
    }));
  },

  setQty: (productId, qty, isBulk, variantId) => {
    if (qty <= 0) {
      get().removeFromCart(productId, isBulk, variantId);
      return;
    }
    set(state => ({
      cart: state.cart.map(l => {
        if (variantId !== undefined) {
          if (l.variant_id !== variantId) return l;
          const max = l.variant_stock_qty ?? Infinity;
          return { ...l, qty: Math.min(qty, max) };
        }
        if (l.product.id === productId && (isBulk === undefined || l.is_bulk === isBulk)) {
          const max = l.product.stock_qty;
          return { ...l, qty: Math.min(qty, max) };
        }
        return l;
      }),
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

  submitCarnetDebt: async (businessId, userId, customerName, amountCents) => {
    const { error } = await supabase.rpc('submit_carnet_debt', {
      p_business_id:   businessId,
      p_seller_id:     userId,
      p_customer_name: customerName.trim(),
      p_amount:        amountCents,
    });
    if (error) {
      console.error('[submitCarnetDebt]', error.code, error.message, error.details);
      useToastStore.getState().show(error.message ?? translateError(error, 'Erreur inconnue'), 'warning');
      haptics.error();
      return false;
    }
    haptics.heavy();
    return true;
  },

  submitSale: async (businessId, userId, payment, customerName, saleDate, discountAmount, clientId, overrideTotalAmount, dueDate) => {
    const { cart } = get();
    if (cart.length === 0) return false;

    const cartSnapshot = [...cart];
    const idempotencyKey = generateId();
    set({ submitting: true, error: null });

    try {
      const catalogTotal = cartSnapshot.reduce((sum, l) => sum + l.unit_price * l.qty, 0);
      const totalAmount = overrideTotalAmount ?? catalogTotal;
      const isFullCredit = payment === null;
      const discount = discountAmount ?? 0;
      const isPartialCredit = !isFullCredit && payment!.amount < (totalAmount - discount) - 0.01;
      const isCredit = isFullCredit || isPartialCredit;
      const today = new Date().toISOString().split('T')[0];

      // When the merchant sold above catalog price, distribute the override
      // proportionally across lines so unit_price always holds the real price
      // charged — there's no separate "catalog vs paid" field any more.
      const priceRatio = overrideTotalAmount && overrideTotalAmount > catalogTotal + 0.5 && catalogTotal > 0
        ? overrideTotalAmount / catalogTotal
        : 1;

      const cartJson = cartSnapshot.map(l => ({
        product_id:   l.product.id,
        qty:          l.qty,
        unit_price:   Math.round(l.unit_price * priceRatio * 100),
        is_bulk:      l.is_bulk,
        product_name: l.product.name,
        variant_id:   l.variant_id ?? null,
        variant_name: l.variant_name ?? null,
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
        ...(dueDate ? { p_due_date: dueDate } : {}),
      };

      const { error: rpcErr } = await supabase.rpc('submit_sale', rpcPayload);
      if (rpcErr) throw rpcErr;

      // Notify managers/admins of the completed sale (online path only)
      const _notifSession = useAuthStore.getState().session;
      if (_notifSession?.activeBusiness && !_notifSession.isDemoMode) {
        notifyEvent({
          businessId,
          eventType: 'sale_completed',
          payload: {
            seller: _notifSession.user.name || 'Vendeur',
            desc: describeSaleForNotification(cartSnapshot),
            amount: formatAmount(totalAmount, _notifSession.activeBusiness.currency),
          },
          targetRoles: ['administrateur', 'manager'],
        });
      }

      set({ cart: [], submitting: false, lastSubmitQueued: false });
      haptics.heavy();
      trackEvent('sale_submitted', businessId, userId, {
        is_credit:      isCredit,
        items_count:    cartSnapshot.length,
        has_discount:   (discountAmount ?? 0) > 0,
        payment_method: payment?.method ?? (isCredit ? 'credit' : null),
        currency:       useAuthStore.getState().session?.activeBusiness?.currency,
        total_amount:   totalAmount,
      });
      return true;
    } catch (err) {
      if (isNetworkError(err)) {
        const catalogTotalOffline = cartSnapshot.reduce((sum, l) => sum + l.unit_price * l.qty, 0);
        const totalAmount = overrideTotalAmount ?? catalogTotalOffline;
        const isFullCredit = payment === null;
        const discount = discountAmount ?? 0;
        const isPartialCredit = !isFullCredit && payment!.amount < (totalAmount - discount) - 0.01;
        const isCredit = isFullCredit || isPartialCredit;
        const today = new Date().toISOString().split('T')[0];

        const priceRatioOffline = overrideTotalAmount && overrideTotalAmount > catalogTotalOffline + 0.5 && catalogTotalOffline > 0
          ? overrideTotalAmount / catalogTotalOffline
          : 1;

        await enqueue('submit_sale', {
          p_business_id:     businessId,
          p_seller_id:       userId,
          p_customer_name:   customerName?.trim() || null,
          p_sale_date:       saleDate || today,
          p_total_amount:    Math.round(totalAmount * 100),
          p_discount_amount: Math.round(discount * 100),
          p_is_credit:       isCredit,
          p_cart:            cartSnapshot.map(l => ({
            product_id:   l.product.id,
            qty:          l.qty,
            unit_price:   Math.round(l.unit_price * priceRatioOffline * 100),
            is_bulk:      l.is_bulk,
            product_name: l.product.name,
            variant_id:   l.variant_id ?? null,
            variant_name: l.variant_name ?? null,
          })),
          p_pay_method:      payment?.method  ?? null,
          p_pay_amount:      payment?.amount  != null ? Math.round(payment.amount * 100) : null,
          p_pay_ref:         payment?.ref_external ?? null,
          p_idempotency_key: idempotencyKey,
          p_client_id:       clientId ?? null,
          ...(dueDate ? { p_due_date: dueDate } : {}),
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
            // Only decrement plain-product lines (variant stock isn't cached locally)
            const line = cartSnapshot.find(l => l.product.id === p.id && !l.variant_id);
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
            due_date: dueDate ?? null,
            created_at: now,
            cancelled_at: null,
            cancellation_reason: null,
            profit: null,
            lines: cartSnapshot.map(l => ({
              id: generateId(),
              product_id:   l.product.id,
              product_name: l.product.name,
              qty:          l.qty,
              unit_price:   l.unit_price,
              is_bulk:      l.is_bulk,
              cost_price:   l.variant_cost_price ?? l.product.cost_price ?? 0,
              variant_id:   l.variant_id ?? null,
              variant_name: l.variant_name ?? null,
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
      const raw = err instanceof Error
        ? err.message
        : typeof (err as { message?: unknown })?.message === 'string'
          ? (err as { message: string }).message
          : 'Une erreur est survenue. La vente n\'a pas été enregistrée.';
      // submit_sale raises plain French exceptions (e.g. "Stock insuffisant…"),
      // which should reach the UI as-is — translateError only overrides `raw`
      // when it recognizes a known raw Postgrest/network/auth error pattern,
      // so a genuine technical error never reaches the merchant untranslated.
      const friendly = translateError(err, raw);
      haptics.error();
      set({ error: friendly, submitting: false, lastSubmitQueued: false });
      return false;
    }
  },

  clearError: () => set({ error: null }),
  reset: () => set({ cart: [], submitting: false, error: null, lastSubmitQueued: false }),
}));
