import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError, friendlyMessage } from '@/lib/errors';
import { generateId } from '@/lib/id';
import { saveFournisseurCache, getFournisseurCache, saveCommandeCache, getCommandeCache, getCacheTimestamp } from '@/lib/db';
import { isNetworkError, withTimeout, withNetworkRetry, reportOfflineFallback } from '@/lib/sync';
import { useProductStore } from '@/stores/products';
import { useAuthStore } from '@/stores/auth';
import { notifyEvent } from '@/src/utils/notifications';
import { createInflightGuard } from '@/lib/inflight';
import { enqueueOnce } from '@/lib/outbox';
import { failureReason } from '@/src/utils/failure';
import { useSyncStore } from '@/stores/sync';
import { getProductCache, saveProductCache, getQueueCount, getVariantsCache, saveVariantsCache } from '@/lib/db';

// A réception books money (stock, cost, transport expense): never twice from a double-tap.
const receptionGuard = createInflightGuard();

// Existing products' stock rises on this phone the moment a réception is queued.
// Best-effort and session-scoped: the server's numbers replace it after sync
// (app/(app)/_layout.tsx refetches products when a drain synced something).
async function applyReceptionStockLocally(
  businessId: string,
  lines: { product_id?: string | null; variant_id?: string | null; qty: number }[],
): Promise<void> {
  const plain = new Map<string, number>();
  const variants = new Map<string, Map<string, number>>();
  for (const l of lines) {
    if (!l.product_id) continue; // a brand-new product doesn't exist locally yet
    if (l.variant_id) {
      const m = variants.get(l.product_id) ?? new Map<string, number>();
      m.set(l.variant_id, (m.get(l.variant_id) ?? 0) + l.qty);
      variants.set(l.product_id, m);
    } else {
      plain.set(l.product_id, (plain.get(l.product_id) ?? 0) + l.qty);
    }
  }
  if (plain.size > 0) {
    const cached = await getProductCache(businessId);
    const base = cached ?? useProductStore.getState().products;
    if (base.length) {
      const updated = base.map(p => (plain.has(p.id) ? { ...p, stock_qty: p.stock_qty + (plain.get(p.id) ?? 0) } : p));
      useProductStore.setState({ products: updated });
      await saveProductCache(businessId, updated);
    }
  }
  for (const [productId, added] of variants) {
    const inMemory = useProductStore.getState().variantsByProduct[productId];
    const base = inMemory ?? (await getVariantsCache(businessId, productId) as import('@/src/types').ProductVariant[] | null);
    if (!base || !base.length) continue;
    const next = base.map(v => (added.has(v.id) ? { ...v, stock_qty: v.stock_qty + (added.get(v.id) ?? 0) } : v));
    useProductStore.setState(state => ({ variantsByProduct: { ...state.variantsByProduct, [productId]: next } }));
    await saveVariantsCache(businessId, productId, next);
  }
}
const supplierDeleteGuard = createInflightGuard();

// See stores/products.ts for the full explanation.
function isStaleBusiness(businessId: string): boolean {
  return useAuthStore.getState().session?.activeBusiness?.id !== businessId;
}

export interface Fournisseur {
  id: string;
  business_id: string;
  name: string;
  phone: string | null;
  country: string | null;
  lead_days: number | null;
  notes: string | null;
  created_by: string;
  created_at: string;
}

export interface CommandeLigne {
  id: string;
  po_id: string;
  product_id: string;
  product_name: string;
  // Required-but-nullable, not optional — a construction site that forgets
  // this must fail to compile, not silently produce a variant-less line
  // (see migration_v167.sql's check 83, and the CommandeForm bug it exists
  // to catch: one of two order screens used to drop this field entirely).
  variant_id: string | null;
  variant_name: string | null;
  qty_ordered: number;
  qty_received: number;
  // NULL = "Prix inconnu" — the merchant didn't record a purchase cost
  // (see db/migration_v221.sql). Callers must handle null before dividing.
  unit_cost: number | null;
}

export interface CommandeAchat {
  id: string;
  business_id: string;
  supplier_id: string;
  supplier_name: string;
  status: string;
  ordered_at: string;
  received_at: string | null;
  total_cost: number;
  proof_image_url?: string | null;
  proof_image_width?: number | null;
  proof_image_height?: number | null;
  proof_attached_by?: string | null;
  proof_attached_at?: string | null;
  lines?: CommandeLigne[];
}

// "Réception intelligente" — Stage 1 (manual draft; Stage 2's AI extraction
// produces this exact same shape, just pre-filled instead of hand-typed).
// product_id null means "create this as a new product" — variant_id is
// only ever set alongside an existing product_id (a brand-new product never
// has variants yet, per the design brief).
export interface ReceptionLine {
  product_id: string | null;
  variant_id: string | null;
  name: string;
  qty: number;
  // NULL = "Prix inconnu" — blank/absent cost is sent as null, not 0
  // (db/migration_v221.sql treats 0 and null identically server-side).
  unit_cost_cents: number | null;
  sale_price_cents: number | null;
}

export interface ConfirmReceptionInput {
  supplierId: string | null; // null = "Marché"
  poId?: string | null;      // Porte 2: the existing order this closes
  lines: ReceptionLine[];
  transportCostCents?: number;
  marginPercent?: number | null;
  receivedDate?: string | null; // 'YYYY-MM-DD' real/backdated delivery date
  /** Reuse the same key on every retry of the same confirmation; the server books it once. */
  idempotencyKey?: string;
}

export interface SupplierDebt {
  id: string;
  business_id: string;
  supplier_id: string;
  amount: number;       // display unit (already ÷100)
  amount_paid: number;  // display unit (already ÷100)
  description: string | null;
  date: string;
  created_at: string;
}

export interface SupplierPayment {
  id: string;
  supplier_id: string;
  amount: number;   // display unit (already ÷100)
  paid_by: string;
  paid_at: string;
  note: string | null;
}

interface FournisseursStore {
  fournisseurs: Fournisseur[];
  commandes: CommandeAchat[];
  debts: SupplierDebt[];
  payments: SupplierPayment[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  offline: boolean;
  offlineSince: number | null;

  fetchFournisseurs: (businessId: string) => Promise<void>;
  createFournisseur: (businessId: string, userId: string, d: { name: string; phone?: string; country?: string; notes?: string; lead_days?: number | null }) => Promise<boolean>;
  updateFournisseur: (id: string, d: { name: string; phone?: string; country?: string; notes?: string; lead_days?: number | null }) => Promise<boolean>;
  deleteFournisseur: (id: string, businessId: string) => Promise<{ ok: boolean; message: string | null }>;
  payDebt: (businessId: string, supplierId: string, paymentAmount: number) => Promise<boolean>;

  fetchCommandes: (businessId: string) => Promise<void>;
  loadCommandeLines: (commandeId: string) => Promise<void>;
  // batchId (from po_receipt_batches, migration_v158.sql) is undefined when
  // ok is false, and also when the receipt succeeded via a queued offline
  // retry — receive_purchase_order hasn't actually run in that case, so
  // there's no real batch row yet and voidPurchaseOrderReceipt has nothing
  // to reverse.
  recevoirCommande: (commandeId: string, businessId: string, userId: string, lines?: { id: string; qty: number }[], shippingCostCents?: number) => Promise<{ ok: boolean; batchId?: string }>;
  voidPurchaseOrderReceipt: (batchId: string, businessId: string, userId: string, reason?: string) => Promise<boolean>;
  confirmReception: (businessId: string, userId: string, input: ConfirmReceptionInput) => Promise<string | null>;
  // Post-save fix-up for the Confirmé step's "De :" chip — confirmReception
  // has already run and already linked any new product to whichever
  // supplier resolved at that moment, so changing it afterward has to be a
  // real UPDATE, not a client-side draft patch. See migration_v189.sql.
  updateReceptionSupplier: (poId: string, businessId: string, userId: string, supplierId: string | null) => Promise<boolean>;

  fetchDebts: (businessId: string) => Promise<void>;
  createDebt: (businessId: string, userId: string, d: { supplierId: string; amount: number; description?: string | null; date: string }) => Promise<boolean>;
  fetchPayments: (businessId: string, supplierId: string) => Promise<void>;

  clearError: () => void;
  reset: () => void;
}

export const useFournisseursStore = create<FournisseursStore>((set, get) => ({
  fournisseurs: [],
  commandes: [],
  debts: [],
  payments: [],
  loading: false,
  saving: false,
  error: null,
  offline: false,
  offlineSince: null,

  fetchFournisseurs: async (businessId) => {
    if (isStaleBusiness(businessId)) return;
    set({ loading: true });
    const [suppliersRes, debtsRes] = await Promise.all([
      withNetworkRetry(() => supabase.from('suppliers').select('*').eq('business_id', businessId).order('name'))
        .catch(err => ({ data: null, error: err })),
      withTimeout(supabase.from('supplier_debts').select('*').eq('business_id', businessId).order('date', { ascending: false }))
        .catch(err => ({ data: null, error: err })),
    ]);
    if (isStaleBusiness(businessId)) { set({ loading: false }); return; }
    if (suppliersRes.error) {
      if (isNetworkError(suppliersRes.error)) {
        reportOfflineFallback('fournisseurs.fetchFournisseurs', suppliersRes.error);
        const cached = await getFournisseurCache(businessId) as Fournisseur[] | null;
        if (isStaleBusiness(businessId)) return;
        if (cached) {
          const ts = await getCacheTimestamp('fournisseur_cache', businessId);
          if (isStaleBusiness(businessId)) return;
          set({ fournisseurs: cached, loading: false, offline: true, offlineSince: ts, error: null });
          return;
        }
        set({ loading: false, offline: true, offlineSince: null, error: null });
        return;
      }
      set({ loading: false, error: translateError(suppliersRes.error, 'Erreur de chargement') });
      return;
    }
    const fournisseurs = (suppliersRes.data ?? []) as Fournisseur[];
    void saveFournisseurCache(businessId, fournisseurs as unknown[]);
    const debts: SupplierDebt[] = (debtsRes.data ?? []).map((d: Record<string, unknown>) => ({
      id: d.id as string,
      business_id: d.business_id as string,
      supplier_id: d.supplier_id as string,
      amount: (d.amount as number) / 100,
      amount_paid: (d.amount_paid as number) / 100,
      description: (d.description as string | null) ?? null,
      date: d.date as string,
      created_at: d.created_at as string,
    }));
    set({ fournisseurs, debts, loading: false, offline: false, offlineSince: null });
  },

  createFournisseur: async (businessId, userId, d) => {
    set({ saving: true, error: null });
    try {
      const { error } = await supabase.from('suppliers').insert({
        id: generateId(),
        business_id: businessId,
        name: d.name.trim(),
        phone: d.phone?.trim() || null,
        country: d.country?.trim() || null,
        notes: d.notes?.trim() || null,
        lead_days: d.lead_days ?? null,
        created_by: userId,
      });
      if (error) { set({ error: translateError(error, 'Impossible de créer le fournisseur'), saving: false }); return false; }
      await get().fetchFournisseurs(businessId);
      set({ saving: false });
      return true;
    } catch (err) {
      set({ saving: false, error: isNetworkError(err) ? 'Vérifiez votre connexion' : translateError(err, 'Impossible de créer le fournisseur') });
      return false;
    }
  },

  updateFournisseur: async (id, d) => {
    set({ saving: true, error: null });
    try {
      const { error } = await supabase.from('suppliers').update({
        name: d.name.trim(),
        phone: d.phone?.trim() || null,
        country: d.country?.trim() || null,
        notes: d.notes?.trim() || null,
        lead_days: d.lead_days ?? null,
      }).eq('id', id);
      if (error) { set({ error: translateError(error, 'Impossible de modifier le fournisseur'), saving: false }); return false; }
      set(state => ({
        fournisseurs: state.fournisseurs.map(f =>
          f.id === id ? { ...f, ...d, name: d.name.trim() } : f,
        ),
        saving: false,
      }));
      return true;
    } catch (err) {
      set({ saving: false, error: isNetworkError(err) ? 'Vérifiez votre connexion' : translateError(err, 'Impossible de modifier le fournisseur') });
      return false;
    }
  },

  deleteFournisseur: (id, businessId) =>
    supplierDeleteGuard.run(async () => {
    try {
      // Try the raw delete FIRST so the DB guard (unpaid debt / purchase
      // orders) can block it with a truthful message and zero side effects.
      // If a linked product's FK is what blocks it, unlink and retry.
      const first = await supabase.from('suppliers').delete().eq('id', id).eq('business_id', businessId);
      if (first.error) {
        if (first.error.code === '23503') {
          // Foreign-key violation from products.supplier_id — unlink then retry.
          await supabase.from('products').update({ supplier_id: null }).eq('supplier_id', id);
          const retry = await supabase.from('suppliers').delete().eq('id', id).eq('business_id', businessId);
          if (retry.error) {
            const message = friendlyMessage(retry.error, 'Impossible de supprimer le fournisseur');
            set({ error: message });
            return { ok: false, message };
          }
        } else {
          const message = friendlyMessage(first.error, 'Impossible de supprimer le fournisseur');
          set({ error: message });
          return { ok: false, message };
        }
      }
      set(state => ({ fournisseurs: state.fournisseurs.filter(f => f.id !== id) }));
      return { ok: true, message: null };
    } catch (err) {
      const message = isNetworkError(err) ? 'Vérifiez votre connexion' : friendlyMessage(err, 'Impossible de supprimer le fournisseur');
      set({ error: message });
      return { ok: false, message };
    }
  }).then(r => (r.ran ? r.value : { ok: false, message: null })),

  payDebt: async (businessId, supplierId, paymentAmount) => {
    set({ saving: true, error: null });
    try {
      const { data, error } = await supabase.rpc('pay_supplier_debt', {
        p_business_id: businessId,
        p_supplier_id: supplierId,
        p_amount_cents: Math.round(paymentAmount * 100),
      });
      if (error) {
        set({ saving: false, error: translateError(error, 'Erreur lors du paiement') });
        return false;
      }
      const remaining = (data as { remaining_cents?: number } | null)?.remaining_cents ?? 0;
      if (remaining > 0) {
        // The supplier has no more outstanding debts — the excess was not applied anywhere.
        set({
          saving: false,
          error: `Paiement partiellement alloué — ${remaining / 100} excèdent les dettes enregistrées. Créez une dette si nécessaire.`,
        });
        await get().fetchDebts(businessId);
        return false;
      }
      await Promise.all([get().fetchDebts(businessId), get().fetchPayments(businessId, supplierId)]);
      set({ saving: false });
      return true;
    } catch (err) {
      set({ saving: false, error: isNetworkError(err) ? 'Vérifiez votre connexion' : translateError(err, 'Erreur lors du paiement') });
      return false;
    }
  },

  fetchCommandes: async (businessId) => {
    if (isStaleBusiness(businessId)) return;
    set({ loading: true });
    const { data, error } = await withNetworkRetry(() =>
      supabase
        .from('purchase_orders')
        .select('*, supplier:suppliers(name)')
        .eq('business_id', businessId)
        .order('ordered_at', { ascending: false }),
    ).catch(err => ({ data: null, error: err }));

    if (isStaleBusiness(businessId)) { set({ loading: false }); return; }
    if (error) {
      if (isNetworkError(error)) {
        reportOfflineFallback('fournisseurs.fetchCommandes', error);
        const cached = await getCommandeCache(businessId) as CommandeAchat[] | null;
        if (isStaleBusiness(businessId)) return;
        if (cached) {
          const ts = await getCacheTimestamp('commande_cache', businessId);
          if (isStaleBusiness(businessId)) return;
          set({ commandes: cached, loading: false, offline: true, offlineSince: ts, error: null });
          return;
        }
        set({ loading: false, offline: true, offlineSince: null, error: null });
        return;
      }
      set({ loading: false, error: translateError(error, 'Erreur de chargement') });
      return;
    }

    const commandes = (data ?? []).map((c: Record<string, unknown>) => ({
      ...c,
      supplier_name: (c.supplier as { name: string } | null)?.name ?? '—',
    } as CommandeAchat));
    void saveCommandeCache(businessId, commandes as unknown[]);
    if (isStaleBusiness(businessId)) { set({ loading: false }); return; }
    set({ commandes, loading: false, offline: false, offlineSince: null });
  },

  loadCommandeLines: async (commandeId) => {
    const { data, error } = await supabase
      .from('po_lines')
      .select('*, product:products(name), variant:product_variants(name)')
      .eq('po_id', commandeId);
    if (error) return;

    // variant_id/variant_name were selected but silently dropped here before —
    // the receiving screen had no way to tell two variant lines of the same
    // product apart (see stores/fournisseurs.ts history for the fix this
    // closes alongside the CommandeForm one in app/(app)/fournisseurs/[id].tsx).
    const lines: CommandeLigne[] = (data ?? []).map((l: Record<string, unknown>) => ({
      id: l.id as string,
      po_id: l.po_id as string,
      product_id: l.product_id as string,
      product_name: (l.product as { name: string } | null)?.name ?? '—',
      variant_id: l.variant_id as string | null,
      variant_name: (l.variant as { name: string } | null)?.name ?? null,
      qty_ordered: l.qty_ordered as number,
      qty_received: l.qty_received as number,
      unit_cost: l.unit_cost as number | null,
    }));

    set(state => ({
      commandes: state.commandes.map(c => c.id === commandeId ? { ...c, lines } : c),
    }));
  },

  // Local-write-first, like the sales: the confirmation is written to the durable
  // outbox and returns at once, so a réception confirmed in a dead zone is not
  // lost — it drains on reconnect through lib/sync.ts's executeOp, and the
  // server (migration_v229) books it exactly once however many times it
  // replays. The idempotency key doubles as the id of the order a new réception
  // creates, so the returned id is the real order id before it ever syncs.
  //
  // What the read side shows while it is queued (honestly): the stock of
  // EXISTING products rises on this phone straight away (a session-scoped
  // estimate, replaced by the server's numbers after sync). It can NOT show
  // yet: products created by this réception, the supplier's debt / the
  // transport expense / "Argent disponible", the order in the supplier's
  // history — all of those come from the server and appear after sync.
  confirmReception: (businessId, userId, input) =>
    receptionGuard.run(async () => {
    set({ saving: true, error: null });
    const key = input.idempotencyKey ?? generateId();
    const payload = {
      p_business_id: businessId,
      p_supplier_id: input.supplierId,
      p_po_id: input.poId ?? null,
      p_lines: input.lines.map(l => ({
        product_id: l.product_id,
        variant_id: l.variant_id,
        name: l.name,
        qty: l.qty,
        unit_cost_cents: l.unit_cost_cents,
        sale_price_cents: l.sale_price_cents,
      })),
      p_transport_cost_cents: input.transportCostCents ?? 0,
      p_margin_percent: input.marginPercent ?? null,
      p_received_date: input.receivedDate ?? null,
      p_idempotency_key: key,
    };
    try {
      await enqueueOnce('confirm_reception', payload);
    } catch (err) {
      // The only failure left: the phone itself could not store it. Nothing was recorded.
      console.error('[confirmReception] local write failed', err);
      set({ saving: false, error: failureReason(err) ?? null });
      return null;
    }
    // The write is durable from here on: nothing below may turn this into a failure.
    try { useSyncStore.setState({ pendingCount: await getQueueCount() }); } catch { /* refreshed on the next sync tick */ }
    try { await applyReceptionStockLocally(businessId, input.lines); } catch (err) {
      console.error('[confirmReception] local stock estimate failed (write already succeeded)', err);
    }
    set({ saving: false });
    useSyncStore.getState().kick();
    return input.poId ?? key;
  }).then(r => (r.ran ? r.value : null)),

  recevoirCommande: async (commandeId, businessId, userId, lines, shippingCostCents = 0) => {
    set({ saving: true, error: null });

    const _commande = get().commandes.find(c => c.id === commandeId);

    const rpcPayload = {
      p_po_id: commandeId,
      p_business_id: businessId,
      p_line_ids: lines ? lines.map(l => l.id) : null,
      p_line_qtys: lines ? lines.map(l => l.qty) : null,
      p_shipping_cost_cents: shippingCostCents,
    };
    const { data, error } = await supabase.rpc('receive_purchase_order', rpcPayload);

    if (error) {
      set({ saving: false, error: translateError(error, 'Impossible de recevoir la commande') });
      return { ok: false };
    }

    // Re-fetch to get accurate status (recu vs recu_partiel determined server-side)
    await get().fetchCommandes(businessId);
    set({ saving: false });

    // Refresh products so the edit form pre-fills with the updated cost_price
    void useProductStore.getState().fetchProducts(businessId, userId);

    // Notify team that new stock has arrived
    const totalItems = lines
      ? lines.reduce((s, l) => s + l.qty, 0)
      : (_commande?.lines?.reduce((s, l) => s + l.qty_ordered, 0) ?? 1);
    notifyEvent({
      businessId,
      eventType: 'po_received',
      payload: { N: totalItems, supplier: _commande?.supplier_name ?? '' },
      targetRoles: ['administrateur', 'manager', 'vendeur'],
    });

    // receive_purchase_order (migration_v158.sql) now RETURNS uuid (the
    // po_receipt_batches row it just logged) instead of void.
    return { ok: true, batchId: data as string | undefined };
  },

  voidPurchaseOrderReceipt: async (batchId, businessId, userId, reason) => {
    set({ saving: true, error: null });
    const { error } = await supabase.rpc('void_purchase_order_receipt', {
      p_batch_id: batchId,
      p_business_id: businessId,
      p_reason: reason ?? null,
    });
    if (error) {
      set({ saving: false, error: translateError(error, 'Annulation impossible') });
      return false;
    }
    await get().fetchCommandes(businessId);
    void useProductStore.getState().fetchProducts(businessId, userId);
    set({ saving: false });
    return true;
  },

  updateReceptionSupplier: async (poId, businessId, userId, supplierId) => {
    try {
      const { error } = await supabase.rpc('update_reception_supplier', {
        p_po_id: poId,
        p_business_id: businessId,
        p_supplier_id: supplierId,
      });
      if (error) {
        const message = translateError(error, 'Impossible de modifier le fournisseur');
        set({ error: message });
        return false;
      }
      await Promise.all([get().fetchCommandes(businessId), get().fetchFournisseurs(businessId)]);
      void useProductStore.getState().fetchProducts(businessId, userId);
      return true;
    } catch (err) {
      const message = isNetworkError(err) ? 'Vérifiez votre connexion' : translateError(err, 'Impossible de modifier le fournisseur');
      set({ error: message });
      return false;
    }
  },

  fetchDebts: async (businessId) => {
    const { data, error } = await supabase
      .from('supplier_debts')
      .select('*')
      .eq('business_id', businessId)
      .order('date', { ascending: false });
    if (error) return;
    if (isStaleBusiness(businessId)) return;
    const debts: SupplierDebt[] = (data ?? []).map((d: Record<string, unknown>) => ({
      id: d.id as string,
      business_id: d.business_id as string,
      supplier_id: d.supplier_id as string,
      amount: (d.amount as number) / 100,
      amount_paid: (d.amount_paid as number) / 100,
      description: (d.description as string | null) ?? null,
      date: d.date as string,
      created_at: d.created_at as string,
    }));
    set({ debts });
  },

  createDebt: async (businessId, userId, d) => {
    set({ saving: true, error: null });
    try {
      const { error } = await supabase.from('supplier_debts').insert({
        business_id: businessId,
        supplier_id: d.supplierId,
        amount: Math.round(d.amount * 100),
        description: d.description?.trim() || null,
        date: d.date,
        amount_paid: 0,
        created_by: userId,
      });
      if (error) { set({ saving: false, error: translateError(error, 'Impossible d\'enregistrer la dette') }); return false; }
      await get().fetchDebts(businessId);
      set({ saving: false });
      return true;
    } catch (err) {
      set({ saving: false, error: isNetworkError(err) ? 'Vérifiez votre connexion' : translateError(err, 'Impossible d\'enregistrer la dette') });
      return false;
    }
  },

  fetchPayments: async (businessId, supplierId) => {
    const { data, error } = await supabase
      .from('supplier_payments')
      .select('id, supplier_id, amount_cents, paid_by, paid_at, note')
      .eq('business_id', businessId)
      .eq('supplier_id', supplierId)
      .order('paid_at', { ascending: false })
      .limit(50);
    if (error) return;
    const payments: SupplierPayment[] = (data ?? []).map((p: Record<string, unknown>) => ({
      id: p.id as string,
      supplier_id: p.supplier_id as string,
      amount: (p.amount_cents as number) / 100,
      paid_by: p.paid_by as string,
      paid_at: p.paid_at as string,
      note: (p.note as string | null) ?? null,
    }));
    set({ payments });
  },

  clearError: () => set({ error: null }),
  reset: () => set({ fournisseurs: [], commandes: [], debts: [], payments: [], loading: false, saving: false, error: null, offline: false, offlineSince: null }),
}));
