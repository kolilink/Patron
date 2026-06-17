import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { generateId, generateFallbackName } from '@/lib/id';
import { translateError } from '@/lib/errors';
import { trackEvent } from '@/lib/analytics';
import { saveVentesCache, getVentesCache, getCacheTimestamp, enqueue, getQueueCount } from '@/lib/db';
import { isNetworkError } from '@/lib/sync';
import { useSyncStore } from '@/stores/sync';

export interface VenteLigne {
  id: string;
  product_id: string;
  product_name: string;
  variant_id?: string | null;
  variant_name?: string | null;
  qty: number;
  unit_price: number;
  is_bulk: boolean;
  cost_price: number;
}

export interface VentePayment {
  id: string;
  method: string;
  amount: number;
  date: string;
}

export interface Vente {
  id: string;
  business_id: string;
  customer_name: string | null;
  client_id: string | null;
  seller_id: string;
  seller_name: string;
  status: string;
  is_credit: boolean;
  total_amount: number;
  discount_amount: number;
  paid_at: string | null;
  sale_date: string | null;
  due_date?: string | null;
  created_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  cancelled_by_id?: string | null;
  cancelled_by_name?: string;
  profit: number | null;
  amount_paid?: number;
  lines?: VenteLigne[];
  payments?: VentePayment[];
}

interface VentesStore {
  sales: Vente[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  offline: boolean;
  offlineSince: number | null;
  fetchSales: (businessId: string, sellerId?: string, since?: string) => Promise<void>;
  loadDetail: (saleId: string) => Promise<void>;
  recordPayment: (saleId: string, amount: number, method: string, date: string) => Promise<{ ok: boolean; fullyPaid: boolean }>;
  recordClientPayment: (customerName: string, businessId: string, amount: number, method: string, date: string) => Promise<{ ok: boolean; fullySettled: boolean }>;
  cancelSale: (saleId: string, businessId: string, userId: string, reason: string) => Promise<boolean>;
  updateSaleClient: (saleId: string, customerName: string) => Promise<boolean>;
  clearError: () => void;
  reset: () => void;
}

export const useVentesStore = create<VentesStore>((set, get) => ({
  sales: [],
  loading: false,
  saving: false,
  error: null,
  offline: false,
  offlineSince: null,

  fetchSales: async (businessId, sellerId, since) => {
    const cacheKey = `${businessId}:${sellerId ?? 'all'}`;

    // Seed from cache on first load so the list is visible while the network fetch runs
    if (get().sales.length === 0) {
      const cached = await getVentesCache(cacheKey) as Vente[] | null;
      if (cached) {
        set({ sales: cached, loading: false, error: null });
      } else {
        set({ loading: true, error: null });
      }
    } else {
      set({ error: null });
    }

    let query = supabase
      .from('sale_orders')
      .select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    if (sellerId) query = query.eq('seller_id', sellerId);
    if (since) query = query.gte('sale_date', since);

    const { data, error: fetchErr } = await query;
    if (fetchErr) {
      if (isNetworkError(fetchErr)) {
        const cached = await getVentesCache(cacheKey) as Vente[] | null;
        if (cached) {
          const ts = await getCacheTimestamp('ventes_cache', cacheKey);
          set({ sales: cached, loading: false, offline: true, offlineSince: ts, error: null });
          return;
        }
        set({
          error: 'Pas de connexion. Ouvrez l\'application en ligne une première fois pour activer le mode hors ligne.',
          loading: false,
          offline: true,
        });
        return;
      }
      set({ loading: false, error: translateError(fetchErr, 'Erreur de chargement') });
      return;
    }
    if (!data) { set({ loading: false }); return; }

    const orderIds = data.map((s: Record<string, unknown>) => s.id as string);
    const sellerIds = [...new Set(data.map((s: Record<string, unknown>) => s.seller_id as string))];
    const cancellerIds = [...new Set(
      data
        .map((s: Record<string, unknown>) => s.cancelled_by_id as string | null)
        .filter((id): id is string => !!id)
    )];
    const allProfileIds = [...new Set([...sellerIds, ...cancellerIds])];

    const [profilesRes, linesRes, paysRes] = await Promise.all([
      supabase.from('profiles').select('id, name').in('id', allProfileIds),
      supabase
        .from('so_lines')
        .select('order_id, qty, unit_price, product:products(cost_price), variant:product_variants(cost_price)')
        .in('order_id', orderIds),
      orderIds.length > 0
        ? supabase.from('payments').select('order_id, amount').in('order_id', orderIds)
        : Promise.resolve({ data: [] }),
    ]);

    const pm: Record<string, string> = {};
    for (const p of (profilesRes.data ?? [])) {
      pm[(p as { id: string; name: string }).id] = (p as { id: string; name: string }).name;
    }

    const profitByOrder: Record<string, number> = {};
    const hasCostByOrder: Record<string, boolean> = {};
    for (const l of (linesRes.data ?? [])) {
      const line = l as unknown as { order_id: string; qty: number; unit_price: number; product: { cost_price: number } | null; variant: { cost_price: number } | null };
      // Use variant cost_price when available — variant products price per-variant not on the parent
      const costPrice = (line.variant?.cost_price ?? line.product?.cost_price ?? 0) / 100;
      const unitPrice = line.unit_price / 100;
      if (costPrice > 0) hasCostByOrder[line.order_id] = true;
      profitByOrder[line.order_id] = (profitByOrder[line.order_id] ?? 0)
        + (unitPrice - costPrice) * line.qty;
    }

    // Sum payments per order to compute amount_paid (used for credit + discounted sales)
    const paidByOrder: Record<string, number> = {};
    for (const p of (paysRes.data ?? []) as { order_id: string; amount: number }[]) {
      paidByOrder[p.order_id] = (paidByOrder[p.order_id] ?? 0) + p.amount / 100;
    }

    const sales = data.map((s: Record<string, unknown>) => {
      const discount = ((s.discount_amount as number) ?? 0) / 100;
      const totalAmount = (s.total_amount as number) / 100;
      const hasDiscount = discount > 0;
      const isCreditStatus = s.status === 'credit';
      return {
        ...s,
        total_amount: totalAmount,
        seller_name: pm[s.seller_id as string] || generateFallbackName(s.seller_id as string),
        is_credit: (s.is_credit as boolean) ?? false,
        discount_amount: discount,
        client_id: (s.client_id as string | null) ?? null,
        cancelled_at: (s.cancelled_at as string | null) ?? null,
        cancellation_reason: (s.cancellation_reason as string | null) ?? null,
        cancelled_by_id: (s.cancelled_by_id as string | null) ?? null,
        cancelled_by_name: s.cancelled_by_id
          ? (pm[s.cancelled_by_id as string] || generateFallbackName(s.cancelled_by_id as string))
          : undefined,
        profit: hasCostByOrder[s.id as string] ? (profitByOrder[s.id as string] ?? null) : null,
        amount_paid: (isCreditStatus || hasDiscount) ? (paidByOrder[s.id as string] ?? 0) : undefined,
      } as Vente;
    });
    void saveVentesCache(cacheKey, sales as unknown[]);
    set({ sales, loading: false, offline: false, offlineSince: null });
  },

  loadDetail: async (saleId) => {
    const [linesRes, paysRes] = await Promise.all([
      supabase.from('so_lines').select('*, product:products(name, cost_price), variant:product_variants(cost_price)').eq('order_id', saleId),
      supabase
        .from('payments')
        .select('id, method, amount, date')
        .eq('order_id', saleId)
        .order('date', { ascending: true }),
    ]);

    if (linesRes.error || paysRes.error) return;

    type ProductJoin = { name: string; cost_price: number } | null;
    type VariantJoin = { cost_price: number } | null;
    const lines: VenteLigne[] = (linesRes.data ?? []).map((l: Record<string, unknown>) => ({
      id: l.id as string,
      product_id: l.product_id as string,
      // Prefer the snapshot name stored at sale time; fall back to current product name
      product_name: (l.product_name as string | null) ?? (l.product as ProductJoin)?.name ?? '—',
      variant_id: (l.variant_id as string | null) ?? null,
      variant_name: (l.variant_name as string | null) ?? null,
      qty: l.qty as number,
      unit_price: (l.unit_price as number) / 100,
      is_bulk: (l.is_bulk as boolean) ?? false,
      // Prefer variant cost_price when present (variant products store cost per variant)
      cost_price: ((l.variant as VariantJoin)?.cost_price ?? (l.product as ProductJoin)?.cost_price ?? 0) / 100,
    }));

    const payments: VentePayment[] = (paysRes.data ?? []).map((p: Record<string, unknown>) => ({
      id: p.id as string,
      method: p.method as string,
      amount: (p.amount as number) / 100,
      date: p.date as string,
    }));

    const amount_paid = payments.reduce((s, p) => s + p.amount, 0);

    set(state => ({
      sales: state.sales.map(s =>
        s.id === saleId ? { ...s, lines, payments, amount_paid } : s,
      ),
    }));
  },

  recordPayment: async (saleId, amount, method, date) => {
    set({ saving: true, error: null });
    const sale = get().sales.find(s => s.id === saleId);
    if (!sale) { set({ saving: false }); return { ok: false, fullyPaid: false }; }

    const alreadyPaid = sale.amount_paid ?? 0;
    const owed = sale.total_amount - (sale.discount_amount ?? 0);
    const newAmountPaid = alreadyPaid + amount;
    const fullyPaid = newAmountPaid >= owed - 0.01;
    const now = new Date().toISOString();

    const paymentRow = {
      id: generateId(),
      order_id: saleId,
      customer_name: sale.customer_name,
      business_id: sale.business_id,
      method,
      amount: Math.round(amount * 100),
      date,
    };

    const applyOptimistic = () => {
      const newPaymentEntry: VentePayment = { id: paymentRow.id, method, amount, date };
      set(state => ({
        sales: state.sales.map(s =>
          s.id === saleId
            ? {
                ...s,
                amount_paid: newAmountPaid,
                status: fullyPaid ? 'paye' : s.status,
                paid_at: fullyPaid ? now : s.paid_at,
                payments: s.payments ? [...s.payments, newPaymentEntry] : undefined,
              }
            : s,
        ),
        saving: false,
      }));
    };

    try {
      const { error: payErr } = await supabase.from('payments').insert(paymentRow);
      if (payErr) throw payErr;

      if (fullyPaid) {
        const { error: statusErr } = await supabase
          .from('sale_orders')
          .update({ status: 'paye', paid_at: now })
          .eq('id', saleId)
          .eq('business_id', sale.business_id);
        if (statusErr) {
          applyOptimistic();
          set({ error: translateError(statusErr, 'Paiement enregistré, mais le statut n\'a pas pu être mis à jour.') });
          return { ok: true, fullyPaid: true };
        }
      }
      applyOptimistic();
      return { ok: true, fullyPaid };
    } catch (err) {
      if (isNetworkError(err)) {
        await enqueue('record_payment', {
          payments: [paymentRow],
          fully_paid_ids: fullyPaid ? [saleId] : [],
        });
        const count = await getQueueCount();
        useSyncStore.setState({ pendingCount: count });
        applyOptimistic();
        return { ok: true, fullyPaid };
      }
      set({ saving: false, error: translateError(err, 'Paiement impossible') });
      return { ok: false, fullyPaid: false };
    }
  },

  recordClientPayment: async (customerName, businessId, amount, method, date) => {
    set({ saving: true, error: null });

    // Oldest credit sales for this client first (FIFO). All allocation logic runs
    // purely over in-memory state, so it works identically online and offline.
    const creditSales = get().sales
      .filter(s =>
        s.customer_name === customerName &&
        s.business_id === businessId &&
        s.status === 'credit',
      )
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    if (creditSales.length === 0) {
      set({ saving: false, error: 'Aucun crédit trouvé pour ce client' });
      return { ok: false, fullySettled: false };
    }

    let toAllocate = amount;
    const paymentRows: object[] = [];
    const storeUpdates: { id: string; newAmountPaid: number; fullyPaid: boolean; paidAt: string }[] = [];
    const now = new Date().toISOString();

    for (const sale of creditSales) {
      if (toAllocate <= 0.005) break;
      const saleOwed = sale.total_amount - (sale.discount_amount ?? 0);
      const saleRemaining = saleOwed - (sale.amount_paid ?? 0);
      if (saleRemaining <= 0.005) continue;

      const allocated = Math.min(toAllocate, saleRemaining);
      const newAmountPaid = (sale.amount_paid ?? 0) + allocated;
      const fullyPaid = newAmountPaid >= saleOwed - 0.01;

      paymentRows.push({
        id: generateId(),
        order_id: sale.id,
        customer_name: customerName,
        business_id: businessId,
        method,
        amount: Math.round(allocated * 100),
        date,
      });

      storeUpdates.push({ id: sale.id, newAmountPaid, fullyPaid, paidAt: now });
      toAllocate -= allocated;
    }

    const fullyPaidIds = storeUpdates.filter(u => u.fullyPaid).map(u => u.id);

    const applyOptimistic = () => {
      set(state => ({
        sales: state.sales.map(s => {
          const upd = storeUpdates.find(u => u.id === s.id);
          if (!upd) return s;
          return {
            ...s,
            amount_paid: upd.newAmountPaid,
            status: upd.fullyPaid ? 'paye' : s.status,
            paid_at: upd.fullyPaid ? upd.paidAt : s.paid_at,
          };
        }),
        saving: false,
      }));
    };

    let fullySettled = false;
    try {
      // Online: server-side atomic allocation with row locks prevents double-payment
      const { data: rpcData, error: rpcErr } = await supabase.rpc('record_client_payment', {
        p_business_id:   businessId,
        p_customer_name: customerName,
        p_amount:        Math.round(amount * 100),
        p_method:        method,
        p_date:          date,
      });
      if (rpcErr) throw rpcErr;
      applyOptimistic();
      fullySettled = (rpcData as { fully_settled: boolean }).fully_settled;
    } catch (err) {
      if (isNetworkError(err)) {
        await enqueue('record_payment', { payments: paymentRows, fully_paid_ids: fullyPaidIds });
        const count = await getQueueCount();
        useSyncStore.setState({ pendingCount: count });
        applyOptimistic();
        fullySettled = get().sales
          .filter(s => s.customer_name === customerName && s.business_id === businessId && s.status === 'credit')
          .reduce((sum, s) => sum + (s.total_amount - (s.discount_amount ?? 0) - (s.amount_paid ?? 0)), 0) < 0.01;
      } else {
        set({ saving: false, error: translateError(err, 'Paiement impossible') });
        return { ok: false, fullySettled: false };
      }
    }

    trackEvent('debt_payment_recorded', businessId, null, { fully_settled: fullySettled });
    return { ok: true, fullySettled };
  },

  cancelSale: async (saleId, businessId, userId, reason) => {
    set({ saving: true, error: null });
    const now = new Date().toISOString();
    const { data: profileData } = await supabase.from('profiles').select('name').eq('id', userId).single();
    const cancellerName = profileData?.name || generateFallbackName(userId);
    const cancelPatch = {
      status: 'annule' as const,
      cancelled_at: now,
      cancellation_reason: reason,
      cancelled_by_id: userId,
      cancelled_by_name: cancellerName,
    };
    try {
      const { error } = await supabase.rpc('cancel_sale', {
        p_sale_id:     saleId,
        p_business_id: businessId,
        p_reason:      reason,
      });
      if (error) throw error;
      set(state => ({
        sales: state.sales.map(s => s.id === saleId ? { ...s, ...cancelPatch } : s),
        saving: false,
      }));
      return true;
    } catch (err) {
      if (isNetworkError(err)) {
        await enqueue('cancel_sale', { p_sale_id: saleId, p_business_id: businessId, p_reason: reason });
        const count = await getQueueCount();
        useSyncStore.setState({ pendingCount: count });
        const updatedSales = get().sales.map(s =>
          s.id === saleId ? { ...s, ...cancelPatch } : s,
        );
        set({ sales: updatedSales, saving: false });
        const sale = get().sales.find(s => s.id === saleId);
        if (sale?.business_id) {
          const cacheKey = `${sale.business_id}:all`;
          void saveVentesCache(cacheKey, updatedSales as unknown[]);
        }
        return true;
      }
      set({ saving: false, error: translateError(err, "Impossible d'annuler") });
      return false;
    }
  },

  updateSaleClient: async (saleId, customerName) => {
    set({ saving: true, error: null });
    const businessId = get().sales.find(s => s.id === saleId)?.business_id;
    const { error } = await supabase
      .from('sale_orders')
      .update({ customer_name: customerName.trim() || null })
      .eq('id', saleId)
      .eq('business_id', businessId ?? '');
    if (error) { set({ saving: false, error: translateError(error, 'Impossible de modifier') }); return false; }
    set(state => ({
      sales: state.sales.map(s =>
        s.id === saleId ? { ...s, customer_name: customerName.trim() || null } : s,
      ),
      saving: false,
    }));
    return true;
  },

  clearError: () => set({ error: null }),
  reset: () => set({ sales: [], loading: false, saving: false, error: null, offline: false, offlineSince: null }),
}));
