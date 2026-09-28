import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { generateId } from '@/lib/id';
import { saveFournisseurCache, getFournisseurCache, saveCommandeCache, getCommandeCache, getCacheTimestamp } from '@/lib/db';
import { isNetworkError, withTimeout, withNetworkRetry, reportOfflineFallback } from '@/lib/sync';
import { useProductStore } from '@/stores/products';
import { useAuthStore } from '@/stores/auth';
import { notifyEvent } from '@/src/utils/notifications';

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
  // (see migration_v159.sql's check 83, and the CommandeForm bug it exists
  // to catch: one of two order screens used to drop this field entirely).
  variant_id: string | null;
  variant_name: string | null;
  qty_ordered: number;
  qty_received: number;
  unit_cost: number;
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
  unit_cost_cents: number;
  sale_price_cents: number | null;
}

export interface ConfirmReceptionInput {
  supplierId: string | null; // null = "Marché"
  poId?: string | null;      // Porte 2: the existing order this closes
  lines: ReceptionLine[];
  transportCostCents?: number;
  marginPercent?: number | null;
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
  deleteFournisseur: (id: string, businessId: string) => Promise<boolean>;
  payDebt: (businessId: string, supplierId: string, paymentAmount: number) => Promise<boolean>;

  fetchCommandes: (businessId: string) => Promise<void>;
  loadCommandeLines: (commandeId: string) => Promise<void>;
  confirmReception: (businessId: string, userId: string, input: ConfirmReceptionInput) => Promise<string | null>;
  // Post-save fix-up for the Confirmé step's "De :" chip — confirmReception
  // has already run and already linked any new product to whichever
  // supplier resolved at that moment, so changing it afterward has to be a
  // real UPDATE, not a client-side draft patch. See migration_v181.sql.
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
    set({ loading: true });
    const [suppliersRes, debtsRes] = await Promise.all([
      withNetworkRetry(() => supabase.from('suppliers').select('*').eq('business_id', businessId).order('name'))
        .catch(err => ({ data: null, error: err })),
      withTimeout(supabase.from('supplier_debts').select('*').eq('business_id', businessId).order('date', { ascending: false }))
        .catch(err => ({ data: null, error: err })),
    ]);
    if (isStaleBusiness(businessId)) return;
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

  deleteFournisseur: async (id, businessId) => {
    try {
      // Unlink products so their FK doesn't block deletion
      await supabase.from('products').update({ supplier_id: null }).eq('supplier_id', id);
      const { error } = await supabase.from('suppliers').delete().eq('id', id).eq('business_id', businessId);
      if (error) { set({ error: translateError(error, 'Impossible de supprimer le fournisseur') }); return false; }
      set(state => ({ fournisseurs: state.fournisseurs.filter(f => f.id !== id) }));
      return true;
    } catch (err) {
      set({ error: isNetworkError(err) ? 'Vérifiez votre connexion' : translateError(err, 'Impossible de supprimer le fournisseur') });
      return false;
    }
  },

  payDebt: async (businessId, supplierId, paymentAmount) => {
    set({ saving: true, error: null });
    try {
      const { data, error } = await supabase.rpc('pay_supplier_debt', {
        p_business_id:  businessId,
        p_supplier_id:  supplierId,
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
    set({ loading: true });
    const { data, error } = await withNetworkRetry(() =>
      supabase
        .from('purchase_orders')
        .select('*, supplier:suppliers(name)')
        .eq('business_id', businessId)
        .order('ordered_at', { ascending: false }),
    ).catch(err => ({ data: null, error: err }));

    if (isStaleBusiness(businessId)) return;
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
    if (isStaleBusiness(businessId)) return;
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
      unit_cost: l.unit_cost as number,
    }));

    set(state => ({
      commandes: state.commandes.map(c => c.id === commandeId ? { ...c, lines } : c),
    }));
  },

  confirmReception: async (businessId, userId, input) => {
    set({ saving: true, error: null });
    try {
      // confirm_reception() creates-or-updates the order + lines (creating
      // any new product along the way) and then calls the existing
      // receive_purchase_order() to do the real stock/cost/transport work —
      // see db/migration_v180.sql for why this reuses that RPC outright
      // instead of duplicating its logic.
      const { data, error } = await supabase.rpc('confirm_reception', {
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
      });

      if (error) {
        set({ saving: false, error: translateError(error, 'Impossible d\'enregistrer la réception') });
        return null;
      }

      await Promise.all([get().fetchCommandes(businessId), get().fetchFournisseurs(businessId)]);
      void useProductStore.getState().fetchProducts(businessId, userId);
      set({ saving: false });

      const totalItems = input.lines.reduce((s, l) => s + l.qty, 0);
      const supplierName = input.supplierId
        ? get().fournisseurs.find(f => f.id === input.supplierId)?.name ?? ''
        : 'Marché';
      notifyEvent({
        businessId,
        eventType: 'po_received',
        payload: { N: totalItems, supplier: supplierName },
        targetRoles: ['administrateur', 'manager', 'vendeur'],
      });

      return data as string;
    } catch (err) {
      set({ saving: false, error: isNetworkError(err) ? 'Vérifiez votre connexion' : translateError(err, 'Impossible d\'enregistrer la réception') });
      return null;
    }
  },

  updateReceptionSupplier: async (poId, businessId, userId, supplierId) => {
    try {
      const { error } = await supabase.rpc('update_reception_supplier', {
        p_po_id: poId,
        p_business_id: businessId,
        p_supplier_id: supplierId,
      });
      if (error) return false;
      await Promise.all([get().fetchCommandes(businessId), get().fetchFournisseurs(businessId)]);
      void useProductStore.getState().fetchProducts(businessId, userId);
      return true;
    } catch {
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
