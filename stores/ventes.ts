import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { generateId } from '@/lib/id';
import { translateError } from '@/lib/errors';
import { trackEvent } from '@/lib/analytics';

export interface VenteLigne {
  id: string;
  product_id: string;
  product_name: string;
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
  seller_id: string;
  seller_name: string;
  status: string;
  is_credit: boolean;
  total_amount: number;
  discount_amount: number;
  paid_at: string | null;
  sale_date: string | null;
  created_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
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

  fetchSales: async (businessId, sellerId, since) => {
    set({ loading: true, error: null });

    let query = supabase
      .from('sale_orders')
      .select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    if (sellerId) query = query.eq('seller_id', sellerId);
    if (since) query = query.gte('sale_date', since);

    const { data, error: fetchErr } = await query;
    if (fetchErr) { set({ loading: false, error: translateError(fetchErr, 'Erreur de chargement') }); return; }
    if (!data) { set({ loading: false }); return; }

    const orderIds = data.map((s: Record<string, unknown>) => s.id as string);
    const sellerIds = [...new Set(data.map((s: Record<string, unknown>) => s.seller_id as string))];

    const [profilesRes, linesRes, paysRes] = await Promise.all([
      supabase.from('profiles').select('id, name').in('id', sellerIds),
      supabase
        .from('so_lines')
        .select('order_id, qty, unit_price, product:products(cost_price)')
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
      const line = l as unknown as { order_id: string; qty: number; unit_price: number; product: { cost_price: number } | null };
      const costPrice = (line.product?.cost_price ?? 0) / 100;
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

    set({
      sales: data.map((s: Record<string, unknown>) => {
        const discount = ((s.discount_amount as number) ?? 0) / 100;
        const totalAmount = (s.total_amount as number) / 100;
        // Expose amount_paid for credit sales and for discounted (rabais) sales
        const hasDiscount = discount > 0;
        const isCreditStatus = s.status === 'credit';
        return {
          ...s,
          total_amount: totalAmount,
          seller_name: pm[s.seller_id as string] ?? 'Inconnu',
          is_credit: (s.is_credit as boolean) ?? false,
          discount_amount: discount,
          cancelled_at: (s.cancelled_at as string | null) ?? null,
          cancellation_reason: (s.cancellation_reason as string | null) ?? null,
          profit: hasCostByOrder[s.id as string] ? (profitByOrder[s.id as string] ?? null) : null,
          amount_paid: (isCreditStatus || hasDiscount) ? (paidByOrder[s.id as string] ?? 0) : undefined,
        } as Vente;
      }),
      loading: false,
    });
  },

  loadDetail: async (saleId) => {
    const [linesRes, paysRes] = await Promise.all([
      supabase.from('so_lines').select('*, product:products(name, cost_price)').eq('order_id', saleId),
      supabase
        .from('payments')
        .select('id, method, amount, date')
        .eq('order_id', saleId)
        .order('date', { ascending: true }),
    ]);

    type ProductJoin = { name: string; cost_price: number } | null;
    const lines: VenteLigne[] = (linesRes.data ?? []).map((l: Record<string, unknown>) => ({
      id: l.id as string,
      product_id: l.product_id as string,
      product_name: (l.product as ProductJoin)?.name ?? '—',
      qty: l.qty as number,
      unit_price: (l.unit_price as number) / 100,
      is_bulk: (l.is_bulk as boolean) ?? false,
      cost_price: ((l.product as ProductJoin)?.cost_price ?? 0) / 100,
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
    const remaining = sale.total_amount - alreadyPaid;

    const { error: payErr } = await supabase.from('payments').insert({
      id: generateId(),
      order_id: saleId,
      customer_name: sale.customer_name,
      business_id: sale.business_id,
      method,
      amount: Math.round(amount * 100),
      date,
    });
    if (payErr) {
      set({ saving: false, error: translateError(payErr, 'Paiement impossible') });
      return { ok: false, fullyPaid: false };
    }

    const newAmountPaid = alreadyPaid + amount;
    const fullyPaid = newAmountPaid >= remaining - 0.01 + alreadyPaid;

    if (fullyPaid) {
      const { error: statusErr } = await supabase
        .from('sale_orders')
        .update({ status: 'paye', paid_at: new Date().toISOString() })
        .eq('id', saleId);
      if (statusErr) {
        set({ saving: false, error: translateError(statusErr, 'Paiement enregistré, mais le statut n\'a pas pu être mis à jour.') });
        return { ok: true, fullyPaid: true };
      }
    }

    const newPaymentEntry: VentePayment = { id: generateId(), method, amount, date };

    set(state => ({
      sales: state.sales.map(s =>
        s.id === saleId
          ? {
              ...s,
              amount_paid: newAmountPaid,
              status: fullyPaid ? 'paye' : s.status,
              paid_at: fullyPaid ? new Date().toISOString() : s.paid_at,
              payments: s.payments ? [...s.payments, newPaymentEntry] : undefined,
            }
          : s,
      ),
      saving: false,
    }));

    return { ok: true, fullyPaid };
  },

  recordClientPayment: async (customerName, businessId, amount, method, date) => {
    set({ saving: true, error: null });

    // Oldest credit sales for this client first (FIFO)
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

    for (const sale of creditSales) {
      if (toAllocate <= 0.005) break;
      const saleRemaining = sale.total_amount - (sale.amount_paid ?? 0);
      if (saleRemaining <= 0.005) continue;

      const allocated = Math.min(toAllocate, saleRemaining);
      const newAmountPaid = (sale.amount_paid ?? 0) + allocated;
      const fullyPaid = newAmountPaid >= sale.total_amount - 0.01;
      const paidAt = new Date().toISOString();

      paymentRows.push({
        id: generateId(),
        order_id: sale.id,
        customer_name: customerName,
        business_id: businessId,
        method,
        amount: Math.round(allocated * 100),
        date,
      });

      storeUpdates.push({ id: sale.id, newAmountPaid, fullyPaid, paidAt });
      toAllocate -= allocated;
    }

    const { error: payErr } = await supabase.from('payments').insert(paymentRows);
    if (payErr) {
      set({ saving: false, error: translateError(payErr, 'Paiement impossible') });
      return { ok: false, fullySettled: false };
    }

    // Flip fully-paid orders to 'paye' in Supabase
    const fullyPaidIds = storeUpdates.filter(u => u.fullyPaid).map(u => u.id);
    if (fullyPaidIds.length > 0) {
      await supabase
        .from('sale_orders')
        .update({ status: 'paye', paid_at: new Date().toISOString() })
        .in('id', fullyPaidIds);
    }

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

    const stillOwed = get().sales
      .filter(s => s.customer_name === customerName && s.business_id === businessId && s.status === 'credit')
      .reduce((sum, s) => sum + (s.total_amount - (s.amount_paid ?? 0)), 0);

    trackEvent('debt_payment_recorded', businessId, null, {
      fully_settled: stillOwed < 0.01,
    });
    return { ok: true, fullySettled: stillOwed < 0.01 };
  },

  cancelSale: async (saleId, businessId, _userId, reason) => {
    set({ saving: true, error: null });
    const { error } = await supabase.rpc('cancel_sale', {
      p_sale_id:     saleId,
      p_business_id: businessId,
      p_reason:      reason,
    });
    if (error) { set({ saving: false, error: translateError(error, "Impossible d'annuler") }); return false; }
    const now = new Date().toISOString();
    set(state => ({
      sales: state.sales.map(s =>
        s.id === saleId ? { ...s, status: 'annule', cancelled_at: now, cancellation_reason: reason } : s,
      ),
      saving: false,
    }));
    return true;
  },

  updateSaleClient: async (saleId, customerName) => {
    set({ saving: true, error: null });
    const { error } = await supabase
      .from('sale_orders')
      .update({ customer_name: customerName.trim() || null })
      .eq('id', saleId);
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
  reset: () => set({ sales: [], loading: false, saving: false, error: null }),
}));
