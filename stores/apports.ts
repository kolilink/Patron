import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { generateFallbackName } from '@/lib/id';

export interface Apport {
  id: string;
  business_id: string;
  amount: number;             // already divided by 100
  injected_by_id: string | null;
  injected_by_name: string | null;
  source_name: string | null;
  note: string | null;
  injected_at: string;
  created_at: string;
}

interface AportsStore {
  apports: Apport[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  fetchApports: (businessId: string) => Promise<void>;
  addApport: (params: {
    businessId: string;
    amount: number;             // display units (÷100 before sending)
    injectedById?: string | null;
    sourceName?: string | null;
    note?: string | null;
    injectedAt: string;
  }) => Promise<boolean>;
  reset: () => void;
}

export const useAportsStore = create<AportsStore>((set, get) => ({
  apports: [],
  loading: false,
  saving: false,
  error: null,

  fetchApports: async (businessId) => {
    set({ loading: true, error: null });

    const { data, error } = await supabase
      .from('capital_injections')
      .select('*, injected_by:profiles!injected_by_id(name)')
      .eq('business_id', businessId)
      .order('injected_at', { ascending: false });

    if (error) {
      set({ loading: false, error: translateError(error, 'Erreur de chargement') });
      return;
    }

    const apports: Apport[] = (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      business_id: r.business_id as string,
      amount: (r.amount as number) / 100,
      injected_by_id: (r.injected_by_id as string | null) ?? null,
      injected_by_name: (r.injected_by as { name: string | null } | null)?.name
        || (r.injected_by_id ? generateFallbackName(r.injected_by_id as string) : null),
      source_name: (r.source_name as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      injected_at: r.injected_at as string,
      created_at: r.created_at as string,
    }));

    set({ apports, loading: false });
  },

  addApport: async ({ businessId, amount, injectedById, sourceName, note, injectedAt }) => {
    set({ saving: true, error: null });

    const { error } = await supabase.rpc('record_injection', {
      p_business_id:    businessId,
      p_amount:         Math.round(amount * 100),
      p_injected_by_id: injectedById ?? null,
      p_source_name:    sourceName ?? null,
      p_note:           note ?? null,
      p_injected_at:    injectedAt,
    });

    if (error) {
      set({ saving: false, error: translateError(error, 'Impossible d\'enregistrer') });
      return false;
    }

    set({ saving: false });
    await get().fetchApports(businessId);
    return true;
  },

  reset: () => set({ apports: [], loading: false, saving: false, error: null }),
}));
