import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { generateId } from '@/lib/id';

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
  lines: { product_id: string; product_name: string; qty: number; unit_cost: number }[];
}

interface FournisseursStore {
  fournisseurs: Fournisseur[];
  commandes: CommandeAchat[];
  loading: boolean;
  saving: boolean;
  error: string | null;

  fetchFournisseurs: (businessId: string) => Promise<void>;
  createFournisseur: (businessId: string, userId: string, d: { name: string; phone?: string; country?: string; notes?: string }) => Promise<boolean>;
  updateFournisseur: (id: string, d: { name: string; phone?: string; country?: string; notes?: string }) => Promise<boolean>;
  deleteFournisseur: (id: string, businessId: string) => Promise<void>;

  fetchCommandes: (businessId: string) => Promise<void>;
  createCommande: (businessId: string, userId: string, input: CreateCommandeInput) => Promise<boolean>;
  loadCommandeLines: (commandeId: string) => Promise<void>;
  recevoirCommande: (commandeId: string, businessId: string, userId: string) => Promise<boolean>;

  clearError: () => void;
  reset: () => void;
}

export const useFournisseursStore = create<FournisseursStore>((set, get) => ({
  fournisseurs: [],
  commandes: [],
  loading: false,
  saving: false,
  error: null,

  fetchFournisseurs: async (businessId) => {
    set({ loading: true });
    const { data } = await supabase
      .from('suppliers')
      .select('*')
      .eq('business_id', businessId)
      .order('name');
    set({ fournisseurs: (data ?? []) as Fournisseur[], loading: false });
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
    await supabase.from('suppliers').delete().eq('id', id);
    set(state => ({ fournisseurs: state.fournisseurs.filter(f => f.id !== id) }));
  },

  fetchCommandes: async (businessId) => {
    set({ loading: true });
    const { data } = await supabase
      .from('purchase_orders')
      .select('*')
      .eq('business_id', businessId)
      .order('ordered_at', { ascending: false });

    if (!data) { set({ loading: false }); return; }

    const { fournisseurs } = get();
    const fm: Record<string, string> = {};
    for (const f of fournisseurs) fm[f.id] = f.name;

    set({
      commandes: data.map((c: Record<string, unknown>) => ({
        ...c,
        supplier_name: fm[c.supplier_id as string] ?? '—',
      } as CommandeAchat)),
      loading: false,
    });
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
      qty_ordered: l.qty,
      qty_received: 0,
      unit_cost: l.unit_cost,
    }));
    const { error: lErr } = await supabase.from('po_lines').insert(lines);
    if (lErr) { set({ error: translateError(lErr, "Impossible d'enregistrer les lignes de commande"), saving: false }); return false; }

    await get().fetchCommandes(businessId);
    set({ saving: false });
    return true;
  },

  loadCommandeLines: async (commandeId) => {
    const { data } = await supabase
      .from('po_lines')
      .select('*, product:products(name)')
      .eq('po_id', commandeId);

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

  recevoirCommande: async (commandeId, businessId, userId) => {
    set({ saving: true });
    const commande = get().commandes.find(c => c.id === commandeId);
    if (!commande?.lines) { set({ saving: false }); return false; }

    const { error: poErr } = await supabase
      .from('purchase_orders')
      .update({ status: 'recu', received_at: new Date().toISOString() })
      .eq('id', commandeId);
    if (poErr) { set({ saving: false }); return false; }

    // Insert stock moves and update product quantities
    const moves = commande.lines.map(l => ({
      id: generateId(),
      business_id: businessId,
      product_id: l.product_id,
      type: 'entree',
      qty: l.qty_ordered,
      ref_id: commandeId,
      ref_type: 'purchase_order',
      note: `Commande reçue`,
      created_by: userId,
    }));
    await supabase.from('stock_moves').insert(moves);

    for (const l of commande.lines) {
      const { data } = await supabase.from('products').select('stock_qty').eq('id', l.product_id).single();
      if (data) {
        await supabase.from('products')
          .update({ stock_qty: (data as { stock_qty: number }).stock_qty + l.qty_ordered })
          .eq('id', l.product_id);
      }
    }

    for (const l of commande.lines) {
      await supabase.from('po_lines').update({ qty_received: l.qty_ordered }).eq('id', l.id);
    }

    set(state => ({
      commandes: state.commandes.map(c =>
        c.id === commandeId ? { ...c, status: 'recu', received_at: new Date().toISOString() } : c,
      ),
      saving: false,
    }));
    return true;
  },

  clearError: () => set({ error: null }),
  reset: () => set({ fournisseurs: [], commandes: [], loading: false, saving: false, error: null }),
}));
