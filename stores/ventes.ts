import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { generateId, generateFallbackName } from '@/lib/id';
import { translateError } from '@/lib/errors';
import { trackEvent } from '@/lib/analytics';
import { saveVentesCache, getVentesCache, getCacheTimestamp, enqueue, getQueueCount } from '@/lib/db';
import { isNetworkError, withTimeout } from '@/lib/sync';
import { useSyncStore } from '@/stores/sync';
import { notifyEvent } from '@/src/utils/notifications';
import { useAuthStore } from '@/stores/auth';
import { formatAmount } from '@/src/utils/format';

// See stores/products.ts for the full explanation — a fetch already in
// flight when the user switches businesses must not overwrite the new
// business's state once it finally resolves.
function isStaleBusiness(businessId: string): boolean {
  return useAuthStore.getState().session?.activeBusiness?.id !== businessId;
}

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

// One entry per edit_sale() call — before/after are the whole-shape snapshots
// the RPC stores, in display units (already /100), so the detail screen can
// diff them directly without knowing which fields changed ahead of time.
export interface SaleEditSnapshot {
  customer_name: string | null;
  client_id: string | null;
  due_date: string | null;
  total_amount: number;
  discount_amount: number;
  lines: { line_id: string; product_name: string; unit_price: number }[];
  payments: { payment_id: string; method: string; amount: number; ref_external: string | null }[];
}

export interface SaleEdit {
  id: string;
  edit_number: number;
  edited_by: string;
  edited_by_name: string;
  edited_at: string;
  reason: string | null;
  before: SaleEditSnapshot;
  after: SaleEditSnapshot;
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
  edit_count: number;
  last_edited_at: string | null;
  last_edited_by?: string | null;
  last_edited_by_name?: string;
  profit: number | null;
  amount_paid?: number;
  lines?: VenteLigne[];
  payments?: VentePayment[];
  edits?: SaleEdit[];
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
  editSale: (params: EditSaleParams) => Promise<{ ok: boolean; error?: string }>;
  clearError: () => void;
  reset: () => void;
}

// Amounts are display-unit (GNF etc, not cents) — converted to bigint cents
// right before the RPC call, same as every other amount in this store.
// lineEdits/paymentEdits only need the entries actually being corrected —
// edit_sale() recomputes total_amount from ALL of so_lines regardless of
// which lines are listed here.
export interface EditSaleParams {
  saleId: string;
  businessId: string;
  customerName: string | null;
  clientId: string | null;
  dueDate: string | null;
  discountAmount: number;
  lineEdits: { lineId: string; unitPrice: number }[];
  paymentEdits: { paymentId: string; method: string; amount: number; refExternal: string | null }[];
  reason: string | null;
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
      if (isStaleBusiness(businessId)) return;
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

    const { data, error: fetchErr } = await withTimeout(query).catch(err => ({ data: null, error: err }));
    if (isStaleBusiness(businessId)) return;
    if (fetchErr) {
      if (isNetworkError(fetchErr)) {
        const cached = await getVentesCache(cacheKey) as Vente[] | null;
        if (isStaleBusiness(businessId)) return;
        if (cached) {
          const ts = await getCacheTimestamp('ventes_cache', cacheKey);
          if (isStaleBusiness(businessId)) return;
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
    const editorIds = [...new Set(
      data
        .map((s: Record<string, unknown>) => s.last_edited_by as string | null)
        .filter((id): id is string => !!id)
    )];
    const allProfileIds = [...new Set([...sellerIds, ...cancellerIds, ...editorIds])];

    const allMemberIds = [...new Set([...sellerIds, ...cancellerIds, ...editorIds])];
    const [profilesRes, linesRes, paysRes, membershipsRes] = await Promise.all([
      supabase.from('profiles').select('id, name').in('id', allProfileIds),
      supabase
        .from('so_lines')
        .select('order_id, qty, cost_price_at_sale, product:products(cost_price), variant:product_variants(cost_price)')
        .in('order_id', orderIds),
      orderIds.length > 0
        ? supabase.from('payments').select('order_id, amount').in('order_id', orderIds)
        : Promise.resolve({ data: [] }),
      allMemberIds.length > 0
        ? supabase.from('memberships').select('user_id, display_name').eq('business_id', businessId).in('user_id', allMemberIds)
        : Promise.resolve({ data: [] }),
    ]);

    const pm: Record<string, string> = {};
    for (const p of (profilesRes.data ?? [])) {
      pm[(p as { id: string; name: string }).id] = (p as { id: string; name: string }).name;
    }

    // display_name set by manager overrides profile name for seller display
    const dm: Record<string, string> = {};
    for (const m of ((membershipsRes as { data: { user_id: string; display_name: string | null }[] | null }).data ?? [])) {
      if (m.display_name) dm[m.user_id] = m.display_name;
    }

    // Accumulate COGS per order using the snapshotted cost (added v81).
    // Falls back to current product/variant cost_price for rows written before v81.
    // Profit is then computed at the order level: (total_amount - discount_amount) - COGS.
    // This correctly handles discounts, above-catalog overrides, and cost-price changes.
    const cogsByOrder: Record<string, number> = {};
    const hasCostByOrder: Record<string, boolean> = {};
    for (const l of (linesRes.data ?? [])) {
      const line = l as unknown as {
        order_id: string;
        qty: number;
        cost_price_at_sale: number | null;
        product: { cost_price: number } | null;
        variant: { cost_price: number } | null;
      };
      const costCents = line.cost_price_at_sale ?? line.variant?.cost_price ?? line.product?.cost_price ?? 0;
      if (costCents > 0) hasCostByOrder[line.order_id] = true;
      cogsByOrder[line.order_id] = (cogsByOrder[line.order_id] ?? 0) + (costCents * line.qty) / 100;
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
      // Revenue = total_amount (already reflects any above-catalog override) minus discount.
      // Subtract COGS to get true gross profit per sale.
      const profit = hasCostByOrder[s.id as string]
        ? (totalAmount - discount) - (cogsByOrder[s.id as string] ?? 0)
        : null;
      return {
        ...s,
        total_amount: totalAmount,
        seller_name: dm[s.seller_id as string] || pm[s.seller_id as string] || generateFallbackName(s.seller_id as string),
        is_credit: (s.is_credit as boolean) ?? false,
        discount_amount: discount,
        client_id: (s.client_id as string | null) ?? null,
        cancelled_at: (s.cancelled_at as string | null) ?? null,
        cancellation_reason: (s.cancellation_reason as string | null) ?? null,
        cancelled_by_id: (s.cancelled_by_id as string | null) ?? null,
        cancelled_by_name: s.cancelled_by_id
          ? (dm[s.cancelled_by_id as string] || pm[s.cancelled_by_id as string] || generateFallbackName(s.cancelled_by_id as string))
          : undefined,
        edit_count: (s.edit_count as number) ?? 0,
        last_edited_at: (s.last_edited_at as string | null) ?? null,
        last_edited_by: (s.last_edited_by as string | null) ?? null,
        last_edited_by_name: s.last_edited_by
          ? (dm[s.last_edited_by as string] || pm[s.last_edited_by as string] || generateFallbackName(s.last_edited_by as string))
          : undefined,
        profit,
        amount_paid: (isCreditStatus || hasDiscount) ? (paidByOrder[s.id as string] ?? 0) : undefined,
      } as Vente;
    });
    void saveVentesCache(cacheKey, sales as unknown[]);
    if (isStaleBusiness(businessId)) return;
    set({ sales, loading: false, offline: false, offlineSince: null });
  },

  loadDetail: async (saleId) => {
    const businessId = get().sales.find(s => s.id === saleId)?.business_id;
    const [linesRes, paysRes, editsRes] = await Promise.all([
      supabase.from('so_lines').select('*, product:products(name, cost_price), variant:product_variants(cost_price)').eq('order_id', saleId),
      supabase
        .from('payments')
        .select('id, method, amount, date')
        .eq('order_id', saleId)
        .order('date', { ascending: true }),
      supabase
        .from('sale_order_edits')
        .select('id, edit_number, edited_by, edited_at, reason, before, after')
        .eq('order_id', saleId)
        .order('edit_number', { ascending: false }),
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
      // Use snapshotted cost (v81+); fall back to live variant/product cost for pre-v81 rows
      cost_price: ((l.cost_price_at_sale as number | null) ?? (l.variant as VariantJoin)?.cost_price ?? (l.product as ProductJoin)?.cost_price ?? 0) / 100,
    }));

    const payments: VentePayment[] = (paysRes.data ?? []).map((p: Record<string, unknown>) => ({
      id: p.id as string,
      method: p.method as string,
      amount: (p.amount as number) / 100,
      date: p.date as string,
    }));

    const amount_paid = payments.reduce((s, p) => s + p.amount, 0);

    // Convert a raw before/after snapshot (cents, as stored by edit_sale())
    // into display units, matching how lines/payments above are converted.
    const toDisplaySnapshot = (snap: Record<string, unknown>): SaleEditSnapshot => ({
      customer_name: (snap.customer_name as string | null) ?? null,
      client_id: (snap.client_id as string | null) ?? null,
      due_date: (snap.due_date as string | null) ?? null,
      total_amount: (snap.total_amount as number) / 100,
      discount_amount: (snap.discount_amount as number) / 100,
      lines: ((snap.lines as Record<string, unknown>[] | null) ?? []).map(l => ({
        line_id: l.line_id as string,
        product_name: l.product_name as string,
        unit_price: (l.unit_price as number) / 100,
      })),
      payments: ((snap.payments as Record<string, unknown>[] | null) ?? []).map(p => ({
        payment_id: p.payment_id as string,
        method: p.method as string,
        amount: (p.amount as number) / 100,
        ref_external: (p.ref_external as string | null) ?? null,
      })),
    });

    let edits: SaleEdit[] | undefined;
    if (!editsRes.error && editsRes.data) {
      const editorIds = [...new Set(editsRes.data.map(e => e.edited_by as string))];
      let nameMap: Record<string, string> = {};
      if (editorIds.length > 0) {
        const [{ data: profs }, { data: mems }] = await Promise.all([
          supabase.from('profiles').select('id, name').in('id', editorIds),
          businessId
            ? supabase.from('memberships').select('user_id, display_name').eq('business_id', businessId).in('user_id', editorIds)
            : Promise.resolve({ data: [] as { user_id: string; display_name: string | null }[] }),
        ]);
        const pm: Record<string, string> = {};
        for (const p of (profs ?? []) as { id: string; name: string }[]) pm[p.id] = p.name;
        const dm: Record<string, string> = {};
        for (const m of (mems ?? []) as { user_id: string; display_name: string | null }[]) {
          if (m.display_name) dm[m.user_id] = m.display_name;
        }
        nameMap = { ...pm, ...dm };
      }
      edits = editsRes.data.map(e => ({
        id: e.id as string,
        edit_number: e.edit_number as number,
        edited_by: e.edited_by as string,
        edited_by_name: nameMap[e.edited_by as string] || generateFallbackName(e.edited_by as string),
        edited_at: e.edited_at as string,
        reason: (e.reason as string | null) ?? null,
        before: toDisplaySnapshot(e.before as Record<string, unknown>),
        after: toDisplaySnapshot(e.after as Record<string, unknown>),
      }));
    }

    set(state => ({
      sales: state.sales.map(s =>
        s.id === saleId ? { ...s, lines, payments, amount_paid, edits } : s,
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
    const paymentId = generateId();
    const amountCents = Math.round(amount * 100);

    const applyOptimistic = () => {
      const newPaymentEntry: VentePayment = { id: paymentId, method, amount, date };
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

    // record_payment() re-checks the real remaining balance server-side and
    // rejects the insert if it would overpay — the on-device `owed`/`fullyPaid`
    // figures above are only used for the optimistic UI update, never trusted
    // for the actual write. This is what stops the same debt being settled
    // twice by two payments that each looked valid on their own device.
    const rpcPayload = {
      p_sale_id:     saleId,
      p_business_id: sale.business_id,
      p_amount:      amountCents,
      p_method:      method,
      p_date:        date,
    };

    try {
      const { data, error: rpcErr } = await supabase.rpc('record_payment', rpcPayload);
      if (rpcErr) throw rpcErr;
      applyOptimistic();
      return { ok: true, fullyPaid: data as boolean };
    } catch (err) {
      if (isNetworkError(err)) {
        await enqueue('record_payment', rpcPayload);
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

      storeUpdates.push({ id: sale.id, newAmountPaid, fullyPaid, paidAt: now });
      toAllocate -= allocated;
    }

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
    // Server-side atomic allocation with row locks prevents double-payment —
    // both online and queued-offline replay go through this same RPC, so a
    // second payment that arrives after the debt is already settled finds
    // nothing left to allocate against instead of recording extra cash nowhere.
    const rpcPayload = {
      p_business_id:   businessId,
      p_customer_name: customerName,
      p_amount:        Math.round(amount * 100),
      p_method:        method,
      p_date:          date,
    };
    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc('record_client_payment', rpcPayload);
      if (rpcErr) throw rpcErr;
      applyOptimistic();
      fullySettled = (rpcData as { fully_settled: boolean }).fully_settled;
    } catch (err) {
      if (isNetworkError(err)) {
        await enqueue('record_client_payment', rpcPayload);
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
    if (fullySettled) {
      const currency = useAuthStore.getState().session?.activeBusiness?.currency ?? 'GNF';
      notifyEvent({
        businessId,
        eventType: 'credit_paid',
        payload: { customer: customerName, amount: formatAmount(amount, currency) },
        targetRoles: ['administrateur', 'manager'],
      });
    }
    return { ok: true, fullySettled };
  },

  cancelSale: async (saleId, businessId, userId, reason) => {
    set({ saving: true, error: null });
    const _cancelledSale = get().sales.find(s => s.id === saleId);
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
      // Notify original seller (if different from canceller) and admins
      if (_cancelledSale) {
        const currency = useAuthStore.getState().session?.activeBusiness?.currency ?? 'GNF';
        const targetUserIds: string[] = [];
        if (_cancelledSale.seller_id && _cancelledSale.seller_id !== userId) {
          targetUserIds.push(_cancelledSale.seller_id);
        }
        notifyEvent({
          businessId,
          eventType: 'sale_cancelled',
          // Net of discount, matching what the sale_completed notification
          // showed for this same sale — total_amount alone is the catalog
          // gross, so a discounted sale sold for e.g. 45 000 was reading back
          // as "annulée · 50 000" here. Same convention as the owed/net figure
          // used everywhere else (total_amount − discount_amount).
          payload: { amount: formatAmount(_cancelledSale.total_amount - (_cancelledSale.discount_amount ?? 0), currency), reason },
          targetUserIds: targetUserIds.length > 0 ? targetUserIds : undefined,
          targetRoles: ['administrateur'],
        });
      }
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

  // Admin/manager only (enforced server-side) — corrects a mistaken sale in
  // place instead of cancelling it, with a full before/after audit trail.
  // Deliberately online-only: not queued through the offline sync_queue,
  // since the 48h edit window is checked against a live server clock and a
  // queued replay after a connectivity gap could silently fail that check
  // with no clear signal to the admin. A network error here is a real,
  // immediate failure the caller should retry once back online, not
  // something to defer.
  editSale: async (params) => {
    set({ saving: true, error: null });
    const {
      saleId, businessId, customerName, clientId, dueDate,
      discountAmount, lineEdits, paymentEdits, reason,
    } = params;

    const rpcPayload = {
      p_sale_id: saleId,
      p_business_id: businessId,
      p_customer_name: customerName,
      p_client_id: clientId,
      p_due_date: dueDate,
      p_discount_amount: Math.round(discountAmount * 100),
      p_line_edits: lineEdits.map(l => ({ line_id: l.lineId, unit_price: Math.round(l.unitPrice * 100) })),
      p_payment_edits: paymentEdits.map(p => ({
        payment_id: p.paymentId, method: p.method,
        amount: Math.round(p.amount * 100), ref_external: p.refExternal,
      })),
      p_reason: reason,
    };

    try {
      const { data, error } = await supabase.rpc('edit_sale', rpcPayload);
      if (error) throw error;
      const updated = data as {
        total_amount: number; discount_amount: number; edit_count: number;
        last_edited_at: string; last_edited_by: string;
        customer_name: string | null; client_id: string | null; due_date: string | null;
      };

      const editorName = useAuthStore.getState().session?.user?.name
        || generateFallbackName(updated.last_edited_by);

      const newSales = get().sales.map(s =>
        s.id === saleId
          ? {
              ...s,
              total_amount: updated.total_amount / 100,
              discount_amount: updated.discount_amount / 100,
              edit_count: updated.edit_count,
              last_edited_at: updated.last_edited_at,
              last_edited_by: updated.last_edited_by,
              last_edited_by_name: editorName,
              customer_name: updated.customer_name,
              client_id: updated.client_id,
              due_date: updated.due_date,
            }
          : s,
      );
      set({ sales: newSales, saving: false });
      void saveVentesCache(`${businessId}:all`, newSales as unknown[]);

      // Refreshes lines/payments/edits — the RPC touched all three and the
      // headline patch above only covers the sale_orders row itself.
      await get().loadDetail(saleId);

      const currency = useAuthStore.getState().session?.activeBusiness?.currency ?? 'GNF';
      notifyEvent({
        businessId,
        eventType: 'sale_edited',
        // Net of discount (RPC returns both in cents), matching the net figure
        // sale_completed showed — not the recomputed catalog gross.
        payload: { editor: editorName, amount: formatAmount((updated.total_amount - updated.discount_amount) / 100, currency) },
        targetRoles: ['administrateur', 'manager'],
        excludeUserId: useAuthStore.getState().session?.user?.id,
      });

      return { ok: true };
    } catch (err) {
      // edit_sale() raises plain French messages (limite atteinte, délai dépassé,
      // paiement désynchronisé, etc.) — pass the raw message through as the
      // fallback so it survives instead of being swallowed by a generic one,
      // same idiom useAuthStore's joinBusiness already uses for join_business().
      const raw = err instanceof Error ? err.message : (err as Record<string, unknown>)?.message as string | undefined;
      const message = translateError(err, raw ?? 'Modification impossible');
      set({ saving: false, error: message });
      return { ok: false, error: message };
    }
  },

  clearError: () => set({ error: null }),
  reset: () => set({ sales: [], loading: false, saving: false, error: null, offline: false, offlineSince: null }),
}));
