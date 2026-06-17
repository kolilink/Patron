import { create } from 'zustand';
import { supabase } from '@/lib/supabase';

interface RapportsState {
  allPayments: { order_id: string; amount: number; date: string }[];
  cogsByOrder: Record<string, number>;
  cogsLoading: boolean;
  fetchPaymentsAndCogs: (businessId: string) => Promise<void>;
  reset: () => void;
}

export const useRapportsStore = create<RapportsState>((set) => ({
  allPayments: [],
  cogsByOrder: {},
  cogsLoading: true,

  fetchPaymentsAndCogs: async (businessId) => {
    set({ cogsLoading: true });
    const since = new Date();
    since.setDate(since.getDate() - 180);

    const { data } = await supabase
      .from('payments')
      .select('order_id, amount, date')
      .eq('business_id', businessId)
      .gte('date', since.toISOString().split('T')[0]);

    const payments = (data ?? []).map(p => ({
      order_id: (p as { order_id: string }).order_id,
      amount: (p as { amount: number }).amount / 100,
      date: (p as { date: string }).date,
    }));

    const orderIds = [...new Set(payments.map(p => p.order_id))];
    const cogs: Record<string, number> = {};

    if (orderIds.length > 0) {
      const { data: lineData } = await supabase
        .from('so_lines')
        .select('order_id, qty, product:products(cost_price), variant:product_variants(cost_price)')
        .in('order_id', orderIds);

      for (const l of (lineData ?? [])) {
        const line = l as unknown as {
          order_id: string;
          qty: number;
          product: { cost_price: number } | null;
          variant: { cost_price: number } | null;
        };
        // Use variant cost_price when available (variant products have cost per variant, not on parent)
        const costPrice = line.variant?.cost_price ?? line.product?.cost_price ?? 0;
        const lineCost = (costPrice / 100) * line.qty;
        cogs[line.order_id] = (cogs[line.order_id] ?? 0) + lineCost;
      }
    }

    set({ allPayments: payments, cogsByOrder: cogs, cogsLoading: false });
  },

  reset: () => set({ allPayments: [], cogsByOrder: {}, cogsLoading: true }),
}));
