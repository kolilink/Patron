import { create } from 'zustand';
import { enqueue, getQueueCount, saveProductCache, getProductCache } from '@/lib/db';
import { generateId } from '@/lib/id';
import { useSyncStore } from '@/stores/sync';
import { useVentesStore } from '@/stores/ventes';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import { trackEvent } from '@/lib/analytics';
import { haptics } from '@/lib/haptics';
import { useToastStore } from '@/stores/toast';
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
  // Separate from lastSubmitQueued (submitSale's own flag) so the two flows
  // can't clobber each other's queued-state signal in the same session.
  lastCarnetDebtQueued: boolean;
  // Same reasoning, third flow: the "Vente rapide" amount-only quick sale
  // (submit_quick_sale, migration_v190) has its own queued-state signal too.
  lastQuickSaleQueued: boolean;
  // The just-created sale_orders id, for the Vendre quick-checkout undo
  // window — submit_sale returns a plain uuid (RETURNS uuid, not a row), but
  // the RPC call previously only ever destructured `error`, discarding it.
  // Only set when the sale actually synced (a queued/offline sale has no
  // server row yet, so there's nothing a cancel_sale call could target).
  lastSaleId: string | null;

  addToCart: (product: Product, bulk?: boolean) => void;
  addToCartVariant: (product: Product, variant: ProductVariant, qty?: number) => void;
  removeFromCart: (productId: string, isBulk?: boolean, variantId?: string) => void;
  setQty: (productId: string, qty: number, isBulk?: boolean, variantId?: string) => void;
  toggleBulk: (productId: string, isBulk?: boolean) => void;
  clearCart: () => void;
  submitCarnetDebt: (businessId: string, userId: string, customerName: string, amountCents: number, clientId: string | null) => Promise<boolean>;
  submitQuickSale: (businessId: string, userId: string, unitPriceCents: number, qty: number, label?: string) => Promise<boolean>;
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

export const useSalesStore = create<SalesStore>((set, get) => ({
  cart: [],
  submitting: false,
  error: null,
  lastSubmitQueued: false,
  lastCarnetDebtQueued: false,
  lastQuickSaleQueued: false,
  lastSaleId: null,

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

  // Local-write-first (offline-first rewrite §5): the RPC is never called
  // from here anymore — only lib/sync.ts's executeOp fires it, on drain.
  // This function's whole job is: write durably, reflect it, kick the
  // drainer, return. No network wait of any kind, online or offline —
  // that's the entire point of the rework (the original 12s-wait finding:
  // every write used to try a live RPC call first and only fell back to
  // the queue on failure, so even a marginal-but-not-dead connection made
  // the UI wait up to withTimeout's 12s before it could even know whether
  // to show success). enqueue() failing (a genuine local SQLite error, not
  // a network one) is the only real failure mode left — there's no "try
  // the network instead" fallback anymore, by design.
  submitCarnetDebt: async (businessId, userId, customerName, amountCents, clientId) => {
    // Idempotency key: dedups this exact write server-side (migration_v178)
    // if the outbox ever replays it more than once (a drain retry racing a
    // second legitimate attempt, etc.) — the RPC's own unique-index guard
    // on this key is what makes "exactly one record syncs" true, not
    // anything client-side.
    const idempotencyKey = generateId();
    const payload = {
      p_business_id:      businessId,
      p_seller_id:        userId,
      p_customer_name:    customerName.trim(),
      p_amount:           amountCents,
      p_client_id:        clientId,
      p_idempotency_key:  idempotencyKey,
    };
    try {
      await enqueue('submit_carnet_debt', payload);
    } catch (err) {
      console.error('[submitCarnetDebt] local write failed', err);
      useToastStore.getState().show("Impossible d'enregistrer sur cet appareil. Réessayez.", 'warning');
      haptics.error();
      set({ lastCarnetDebtQueued: false });
      return false;
    }
    const count = await getQueueCount();
    useSyncStore.setState({ pendingCount: count });
    // Reflects this debt in the carnet/dashboard/ventes list instantly —
    // rebuilds from the durable outbox, so it survives a kill before the
    // next line even runs (lib/pendingOverlay.ts). Wrapped: the write
    // above already durably succeeded, so a failure here (the overlay
    // rebuild, not the write itself) must never flip this function's
    // reported outcome to false — that would falsely tell the merchant
    // her debt wasn't recorded when it actually was. The UI just won't
    // reflect it until the next natural refresh in that rare case.
    try {
      await useVentesStore.getState().refreshPendingOverlay();
    } catch (err) {
      console.error('[submitCarnetDebt] refreshPendingOverlay failed (write already succeeded)', err);
    }
    useSyncStore.getState().kick();
    set({ lastCarnetDebtQueued: true });
    haptics.success();
    trackEvent('credit_debt_queued', businessId, userId);
    return true;
  },

  submitQuickSale: async (businessId, userId, unitPriceCents, qty, label) => {
    // Same idempotency-key + offline-queue shape as submitCarnetDebt above —
    // submit_quick_sale (migration_v190) has the identical dedup guard.
    // p_label is optional free text ("Riz, sac de 5kg") — trimmed to null
    // when blank so the RPC's own COALESCE(..., 'Vente rapide') fallback
    // applies, rather than storing an empty string as the line's name.
    const idempotencyKey = generateId();
    const payload = {
      p_business_id:      businessId,
      p_seller_id:        userId,
      p_unit_price:       unitPriceCents,
      p_qty:              qty,
      p_label:            label?.trim() || null,
      p_idempotency_key:  idempotencyKey,
    };
    try {
      await enqueue('submit_quick_sale', payload);
    } catch (err) {
      console.error('[submitQuickSale] local write failed', err);
      useToastStore.getState().show("Impossible d'enregistrer sur cet appareil. Réessayez.", 'warning');
      haptics.error();
      set({ lastQuickSaleQueued: false });
      return false;
    }
    const count = await getQueueCount();
    useSyncStore.setState({ pendingCount: count });
    try {
      await useVentesStore.getState().refreshPendingOverlay();
    } catch (err) {
      console.error('[submitQuickSale] refreshPendingOverlay failed (write already succeeded)', err);
    }
    useSyncStore.getState().kick();
    set({ lastQuickSaleQueued: true });
    haptics.success();
    trackEvent('quick_sale_queued', businessId, userId);
    return true;
  },

  // Local-write-first, same shape as submitCarnetDebt/submitQuickSale above.
  // Real, deliberate consequence worth being explicit about: submit_sale's
  // own server-side rejections (most notably "Stock insuffisant…") can no
  // longer be discovered synchronously — there is no more live RPC call in
  // this function at all, only lib/sync.ts's executeOp ever calls it, at
  // drain time. A genuine oversell attempt now always looks like it
  // succeeded in the moment (cart clears, confirmation shows) and is only
  // actually rejected later, quietly, via §3's failed_permanent
  // classification + the future Paramètres line (§8) — never blocking
  // capture is the explicit, approved tradeoff (Decision A), and the
  // approved plan's own FAILURE HANDLING section anticipates exactly this
  // class of deferred validation failure. vendre.tsx's existing
  // "Stock insuffisant" refetch-and-trim-cart branch is consequently
  // unreachable through this path going forward — left in place rather
  // than removed here (out of this section's stores-only scope), since
  // dead code that never executes isn't a correctness risk on its own.
  submitSale: async (businessId, userId, payment, customerName, saleDate, discountAmount, clientId, overrideTotalAmount, dueDate) => {
    const { cart } = get();
    if (cart.length === 0) return false;

    const cartSnapshot = [...cart];
    const idempotencyKey = generateId();
    set({ submitting: true, error: null });

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

    try {
      await enqueue('submit_sale', rpcPayload);
    } catch (err) {
      console.error('[submitSale] local write failed', err);
      haptics.error();
      set({ error: "Impossible d'enregistrer sur cet appareil. Réessayez.", submitting: false, lastSubmitQueued: false, lastSaleId: null });
      return false;
    }

    const count = await getQueueCount();
    useSyncStore.setState({ pendingCount: count });

    // No server row exists synchronously for ANY sale anymore (not just a
    // previously-offline one) — nothing a cancel_sale call could target
    // yet, so lastSaleId always stays null and the undo window in
    // vendre.tsx no longer has anything to key off in this moment. See
    // this function's own header comment for the broader "Stock
    // insuffisant can't be caught live anymore" consequence this is part
    // of — both are the same underlying tradeoff (Decision A), not two
    // separate issues.
    set({ cart: [], submitting: false, lastSubmitQueued: true, lastSaleId: null });
    haptics.success();
    trackEvent('sale_submitted', businessId, userId, {
      is_credit:      isCredit,
      items_count:    cartSnapshot.length,
      has_discount:   (discountAmount ?? 0) > 0,
      payment_method: payment?.method ?? (isCredit ? 'credit' : null),
      currency:       useAuthStore.getState().session?.activeBusiness?.currency,
      total_amount:   totalAmount,
    });

    // Optimistically decrement stock in both the local product cache and the
    // in-memory Zustand store so the POS reflects updated quantities
    // immediately — unconditional now (every sale takes this path, not
    // just a previously-offline one). Orthogonal to the sales pending-
    // overlay rework below: this is the product store's own best-effort,
    // session-scoped estimate, not derived from a durable per-product
    // outbox overlay (that would be real additional scope beyond what
    // Phase 1 covers — product stock accuracy across a kill+reopen isn't
    // one of its acceptance criteria, unlike the sales/ledger data this
    // section is actually responsible for).
    void (async () => {
      try {
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
      } catch (err) {
        // Best-effort, session-only estimate (see the comment above) — a
        // failure here must never become an unhandled rejection out of
        // this fire-and-forget IIFE. Same class of bug as drainQueue's own
        // missing top-level catch (lib/sync.ts), just a different call
        // site introduced in this same rework — caught by the real test
        // suite crashing a worker process, not assumed safe.
        console.error('[submitSale] optimistic stock decrement failed', err);
      }
    })();

    // Reflects this sale in the ledger/dashboard instantly, durably —
    // rebuilds from the outbox (which already has this exact item, just
    // enqueued above) merged onto the untouched synced cache. Replaces the
    // old ad hoc "build one optimisticSale object here and prepend it into
    // ventes_cache directly" pattern entirely: refreshPendingOverlay now
    // re-derives the same result (and every other pending op's effect)
    // from the single shared projector in lib/pendingOverlay.ts, so this
    // function no longer needs its own copy of that logic at all. Wrapped
    // for the same reason as submitCarnetDebt/submitQuickSale above — the
    // enqueue already durably succeeded, so a failure here must never
    // flip this function's return value to false.
    try {
      await useVentesStore.getState().refreshPendingOverlay();
    } catch (err) {
      console.error('[submitSale] refreshPendingOverlay failed (write already succeeded)', err);
    }
    useSyncStore.getState().kick();

    // sale_completed notification: fired ONLY from lib/sync.ts's executeOp
    // (notifyQueuedSaleSynced), which runs once, unconditionally, the
    // moment submit_sale's RPC actually succeeds — whether that's 50ms
    // from now or 5 days from now. This function must NOT also notify
    // here: under the old two-path design, exactly one of "live success"
    // or "offline queued+later synced" ever ran, so only one notify call
    // ever fired for a given sale. Under local-write-first, every sale
    // takes this same enqueue path, so notifying here too would double-
    // notify admins/managers for any sale that happens to sync quickly.
    return true;
  },

  clearError: () => set({ error: null }),
  reset: () => set({ cart: [], submitting: false, error: null, lastSubmitQueued: false, lastSaleId: null }),
}));
