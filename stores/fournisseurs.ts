import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { generateId } from '@/lib/id';
import { saveFournisseurCache, getFournisseurCache, saveCommandeCache, getCommandeCache } from '@/lib/db';
import { isNetworkError } from '@/lib/sync';
import { useProductStore } from '@/stores/products';
import { notifyEvent } from '@/src/utils/notifications';

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
  variant_id?: string | null;
  variant_name?: string | null;
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
  lines?: CommandeLigne[];
}

export interface CreateCommandeInput {
  supplierId: string;
  lines: { product_id: string; product_name: string; variant_id?: string | null; qty: number; unit_cost: number }[];
  amountPaid?: number; // display units; undefined or >= total means fully paid
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

  fetchFournisseurs: (businessId: string) => Promise<void>;
  createFournisseur: (businessId: string, userId: string, d: { name: string; phone?: string; country?: string; notes?: string; lead_days?: number | null }) => Promise<boolean>;
  updateFournisseur: (id: string, d: { name: string; phone?: string; country?: string; notes?: string; lead_days?: number | null }) => Promise<boolean>;
  deleteFournisseur: (id: string, businessId: string) => Promise<boolean>;
  payDebt: (businessId: string, supplierId: string, paymentAmount: number) => Promise<boolean>;

  fetchCommandes: (businessId: string) => Promise<void>;
  createCommande: (businessId: string, userId: string, input: CreateCommandeInput) => Promise<boolean>;
  loadCommandeLines: (commandeId: string) => Promise<void>;
  recevoirCommande: (commandeId: string, businessId: string, userId: string, lines?: { id: string; qty: number }[], shippingCostCents?: number) => Promise<boolean>;

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

  fetchFournisseurs: async (businessId) => {
    set({ loading: true });
    const [suppliersRes, debtsRes] = await Promise.all([
      supabase.from('suppliers').select('*').eq('business_id', businessId).order('name'),
      supabase.from('supplier_debts').select('*').eq('business_id', businessId).order('date', { ascending: false }),
    ]);
    if (suppliersRes.error) {
      if (isNetworkError(suppliersRes.error)) {
        const cached = await getFournisseurCache(businessId) as Fournisseur[] | null;
        if (cached) { set({ fournisseurs: cached, loading: false, offline: true, error: null }); return; }
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
    set({ fournisseurs, debts, loading: false, offline: false });
  },

  createFournisseur: async (businessId, userId, d) => {
    set({ saving: true, error: null });
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
  },

  updateFournisseur: async (id, d) => {
    set({ saving: true, error: null });
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
  },

  deleteFournisseur: async (id, businessId) => {
    // Unlink products so their FK doesn't block deletion
    await supabase.from('products').update({ supplier_id: null }).eq('supplier_id', id);
    const { error } = await supabase.from('suppliers').delete().eq('id', id).eq('business_id', businessId);
    if (error) { set({ error: translateError(error, 'Impossible de supprimer le fournisseur') }); return false; }
    set(state => ({ fournisseurs: state.fournisseurs.filter(f => f.id !== id) }));
    return true;
  },

  payDebt: async (businessId, supplierId, paymentAmount) => {
    set({ saving: true, error: null });
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
  },

  fetchCommandes: async (businessId) => {
    set({ loading: true });
    const { data, error } = await supabase
      .from('purchase_orders')
      .select('*, supplier:suppliers(name)')
      .eq('business_id', businessId)
      .order('ordered_at', { ascending: false });

    if (error) {
      if (isNetworkError(error)) {
        const cached = await getCommandeCache(businessId) as CommandeAchat[] | null;
        if (cached) { set({ commandes: cached, loading: false, offline: true, error: null }); return; }
      }
      set({ loading: false, error: translateError(error, 'Erreur de chargement') });
      return;
    }

    const commandes = (data ?? []).map((c: Record<string, unknown>) => ({
      ...c,
      supplier_name: (c.supplier as { name: string } | null)?.name ?? '—',
    } as CommandeAchat));
    void saveCommandeCache(businessId, commandes as unknown[]);
    set({ commandes, loading: false, offline: false });
  },

  createCommande: async (businessId, userId, input) => {
    set({ saving: true, error: null });
    const poId = generateId();
    const total = input.lines.reduce((s, l) => s + l.qty * l.unit_cost, 0);

    const { error: poErr } = await supabase.from('purchase_orders').insert({
      id: poId,
      business_id: businessId,
      supplier_id: input.supplierId,
      status: 'brouillon',
      ordered_at: new Date().toISOString(),
      total_cost: total,
      created_by: userId,
    });
    if (poErr) { set({ error: translateError(poErr, 'Impossible de créer la commande'), saving: false }); return false; }

    const lines = input.lines.map(l => ({
      id: generateId(),
      po_id: poId,
      product_id: l.product_id,
      variant_id: l.variant_id ?? null,
      qty_ordered: l.qty,
      qty_received: 0,
      unit_cost: l.unit_cost,
    }));
    const { error: lErr } = await supabase.from('po_lines').insert(lines);
    if (lErr) {
      await supabase.from('purchase_orders').delete().eq('id', poId);
      set({ error: translateError(lErr, "Impossible d'enregistrer les lignes de commande"), saving: false });
      return false;
    }

    // Auto-create a supplier debt for any unpaid balance
    const amountPaid = input.amountPaid ?? total;
    if (amountPaid < total - 0.01) {
      const owed = total - amountPaid;
      await supabase.from('supplier_debts').insert({
        business_id: businessId,
        supplier_id: input.supplierId,
        amount: Math.round(owed * 100),
        amount_paid: 0,
        description: null,
        date: new Date().toISOString().split('T')[0],
        created_by: userId,
      });
      await get().fetchDebts(businessId);
    }

    await get().fetchCommandes(businessId);
    set({ saving: false });
    return true;
  },

  loadCommandeLines: async (commandeId) => {
    const { data, error } = await supabase
      .from('po_lines')
      .select('*, product:products(name)')
      .eq('po_id', commandeId);
    if (error) return;

    const lines: CommandeLigne[] = (data ?? []).map((l: Record<string, unknown>) => ({
      id: l.id as string,
      po_id: l.po_id as string,
      product_id: l.product_id as string,
      product_name: (l.product as { name: string } | null)?.name ?? '—',
      qty_ordered: l.qty_ordered as number,
      qty_received: l.qty_received as number,
      unit_cost: l.unit_cost as number,
    }));

    set(state => ({
      commandes: state.commandes.map(c => c.id === commandeId ? { ...c, lines } : c),
    }));
  },

  recevoirCommande: async (commandeId, businessId, userId, lines, shippingCostCents = 0) => {
    set({ saving: true, error: null });

    const _commande = get().commandes.find(c => c.id === commandeId);

    const { error } = await supabase.rpc('receive_purchase_order', {
      p_po_id: commandeId,
      p_business_id: businessId,
      p_line_ids: lines ? lines.map(l => l.id) : null,
      p_line_qtys: lines ? lines.map(l => l.qty) : null,
      p_shipping_cost_cents: shippingCostCents,
    });

    if (error) {
      set({ saving: false, error: translateError(error, 'Impossible de recevoir la commande') });
      return false;
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

    return true;
  },

  fetchDebts: async (businessId) => {
    const { data, error } = await supabase
      .from('supplier_debts')
      .select('*')
      .eq('business_id', businessId)
      .order('date', { ascending: false });
    if (error) return;
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
  reset: () => set({ fournisseurs: [], commandes: [], debts: [], payments: [], loading: false, saving: false, error: null, offline: false }),
}));
