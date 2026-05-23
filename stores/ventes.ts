import { create } from 'zustand';
import { supabase } from '@/lib/supabase';

function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export interface VenteLigne {
  id: string;
  product_id: string;
  product_name: string;
  qty: number;
  unit_price: number;
  is_bulk: boolean;
}

export interface Vente {
  id: string;
  business_id: string;
  customer_name: string | null;
  seller_id: string;
  seller_name: string;
  status: string;
  total_amount: number;
  paid_at: string | null;
  sale_date: string | null;
  created_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  lines?: VenteLigne[];
  payments?: { method: string; amount: number }[];
}

interface VentesStore {
  sales: Vente[];
  loading: boolean;
  saving: boolean;
  fetchSales: (businessId: string, sellerId?: string) => Promise<void>;
  loadDetail: (saleId: string) => Promise<void>;
  markPaid: (saleId: string, method: string) => Promise<boolean>;
  cancelSale: (saleId: string, businessId: string, userId: string, reason: string) => Promise<boolean>;
  updateSaleClient: (saleId: string, customerName: string) => Promise<boolean>;
}

export const useVentesStore = create<VentesStore>((set, get) => ({
  sales: [],
  loading: false,
  saving: false,

  fetchSales: async (businessId, sellerId) => {
    set({ loading: true });

    let query = supabase
      .from('sale_orders')
      .select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .limit(200);

    if (sellerId) {
      query = query.eq('seller_id', sellerId);
    }

    const { data } = await query;

    if (!data) { set({ loading: false }); return; }

    const sellerIds = [...new Set(data.map((s: Record<string, string>) => s.seller_id))];
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, name')
      .in('id', sellerIds);

    const pm: Record<string, string> = {};
    for (const p of (profiles ?? [])) pm[(p as { id: string; name: string }).id] = (p as { id: string; name: string }).name;

    set({
      sales: data.map((s: Record<string, unknown>) => ({
        ...s,
        seller_name: pm[s.seller_id as string] ?? 'Inconnu',
        cancelled_at: (s.cancelled_at as string | null) ?? null,
        cancellation_reason: (s.cancellation_reason as string | null) ?? null,
      } as Vente)),
      loading: false,
    });
  },

  loadDetail: async (saleId) => {
    const [linesRes, paysRes] = await Promise.all([
      supabase.from('so_lines').select('*, product:products(name)').eq('order_id', saleId),
      supabase.from('payments').select('method, amount').eq('order_id', saleId),
    ]);

    const lines: VenteLigne[] = (linesRes.data ?? []).map((l: Record<string, unknown>) => ({
      id: l.id as string,
      product_id: l.product_id as string,
      product_name: (l.product as { name: string } | null)?.name ?? '—',
      qty: l.qty as number,
      unit_price: l.unit_price as number,
      is_bulk: (l.is_bulk as boolean) ?? false,
    }));

    set(state => ({
      sales: state.sales.map(s =>
        s.id === saleId ? { ...s, lines, payments: paysRes.data ?? [] } : s,
      ),
    }));
  },

  markPaid: async (saleId, method) => {
    set({ saving: true });
    const sale = get().sales.find(s => s.id === saleId);
    if (!sale) { set({ saving: false }); return false; }

    const { error } = await supabase
      .from('sale_orders')
      .update({ status: 'paye', paid_at: new Date().toISOString() })
      .eq('id', saleId);
    if (error) { set({ saving: false }); return false; }

    await supabase.from('payments').insert({
      id: generateId(),
      order_id: saleId,
      method,
      amount: sale.total_amount,
    });

    set(state => ({
      sales: state.sales.map(s =>
        s.id === saleId ? { ...s, status: 'paye', paid_at: new Date().toISOString() } : s,
      ),
      saving: false,
    }));
    return true;
  },

  cancelSale: async (saleId, businessId, userId, reason) => {
    set({ saving: true });

    // Load lines if not cached
    let lines = get().sales.find(s => s.id === saleId)?.lines;
    if (!lines) {
      const { data } = await supabase.from('so_lines').select('*').eq('order_id', saleId);
      lines = (data ?? []).map((l: Record<string, unknown>) => ({
        id: l.id as string,
        product_id: l.product_id as string,
        product_name: '',
        qty: l.qty as number,
        unit_price: l.unit_price as number,
        is_bulk: (l.is_bulk as boolean) ?? false,
      }));
    }

    const now = new Date().toISOString();
    const { error } = await supabase
      .from('sale_orders')
      .update({ status: 'annule', cancelled_at: now, cancellation_reason: reason })
      .eq('id', saleId);

    if (error) { set({ saving: false }); return false; }

    // Restore stock for each line
    for (const line of (lines ?? [])) {
      await supabase.from('stock_moves').insert({
        id: generateId(),
        business_id: businessId,
        product_id: line.product_id,
        type: 'entree',
        qty: line.qty,
        ref_id: saleId,
        ref_type: 'annulation',
        note: `Annulation: ${reason}`,
        created_by: userId,
      });

      const { data: prod } = await supabase
        .from('products')
        .select('stock_qty')
        .eq('id', line.product_id)
        .single();

      if (prod) {
        const newQty = ((prod as { stock_qty: number }).stock_qty) + line.qty;
        await supabase.from('products').update({ stock_qty: newQty }).eq('id', line.product_id);
      }
    }

    set(state => ({
      sales: state.sales.map(s =>
        s.id === saleId
          ? { ...s, status: 'annule', cancelled_at: now, cancellation_reason: reason }
          : s,
      ),
      saving: false,
    }));
    return true;
  },

  updateSaleClient: async (saleId, customerName) => {
    set({ saving: true });
    const { error } = await supabase
      .from('sale_orders')
      .update({ customer_name: customerName.trim() || null })
      .eq('id', saleId);
    if (error) { set({ saving: false }); return false; }
    set(state => ({
      sales: state.sales.map(s =>
        s.id === saleId ? { ...s, customer_name: customerName.trim() || null } : s,
      ),
      saving: false,
    }));
    return true;
  },
}));
