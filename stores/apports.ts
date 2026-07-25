import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { generateFallbackName } from '@/lib/id';
import { saveApportsCache, getApportsCache, getCacheTimestamp } from '@/lib/db';
import { isNetworkError, withTimeout } from '@/lib/sync';
import { useAuthStore } from '@/stores/auth';

// See stores/products.ts for the full explanation.
function isStaleBusiness(businessId: string): boolean {
  return useAuthStore.getState().session?.activeBusiness?.id !== businessId;
}

export interface Apport {
  id: string;
  business_id: string;
  amount: number;             // already divided by 100 — negative = withdrawal
  injected_by_id: string | null;
  injected_by_name: string | null;
  source_name: string | null;
  note: string | null;
  injected_at: string;
  created_at: string;
  created_by_name: string | null;
  edited_at: string | null;
  edited_by_name: string | null;
  proof_image_url: string | null;
  proof_image_width: number | null;
  proof_image_height: number | null;
}

interface AportsStore {
  apports: Apport[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  offline: boolean;
  offlineSince: number | null;
  fetchApports: (businessId: string) => Promise<void>;
  addApport: (params: {
    businessId: string;
    amount: number;             // display units (÷100 before sending)
    injectedById?: string | null;
    sourceName?: string | null;
    note?: string | null;
    injectedAt: string;
  }) => Promise<string | null>;   // new row id, or null on failure — lets the caller attach a proof photo
  editApport: (params: {
    id: string;
    businessId: string;
    amount: number;             // display units (÷100 before sending)
    injectedById?: string | null;
    sourceName?: string | null;
    note?: string | null;
    injectedAt: string;
  }) => Promise<boolean>;
  recordWithdrawal: (params: {
    businessId: string;
    amount: number;             // display units (÷100 before sending), positive
    injectedById?: string | null;
    sourceName?: string | null;
    note?: string | null;
    withdrawnAt: string;
  }) => Promise<string | null>;   // new row id, or null on failure
  reset: () => void;
}

export const useAportsStore = create<AportsStore>((set, get) => ({
  apports: [],
  loading: false,
  saving: false,
  error: null,
  offline: false,
  offlineSince: null,

  fetchApports: async (businessId) => {
    if (get().apports.length === 0) {
      const cached = await getApportsCache(businessId) as Apport[] | null;
      if (isStaleBusiness(businessId)) return;
      if (cached) {
        set({ apports: cached, loading: false, error: null });
      } else {
        set({ loading: true, error: null });
      }
    } else {
      set({ error: null });
    }

    const { data, error } = await withTimeout(
      supabase
        .from('capital_injections')
        .select('*, injected_by:profiles!injected_by_id(name), creator:profiles!created_by(name), editor:profiles!edited_by(name)')
        .eq('business_id', businessId)
        .order('injected_at', { ascending: false }),
    ).catch(err => ({ data: null, error: err }));

    if (isStaleBusiness(businessId)) return;
    if (error) {
      if (isNetworkError(error)) {
        const cached = await getApportsCache(businessId) as Apport[] | null;
        if (isStaleBusiness(businessId)) return;
        if (cached) {
          const ts = await getCacheTimestamp('apports_cache', businessId);
          if (isStaleBusiness(businessId)) return;
          set({ apports: cached, loading: false, offline: true, offlineSince: ts, error: null });
          return;
        }
        set({ loading: false, offline: true, offlineSince: null, error: null });
        return;
      }
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
      created_by_name: (r.creator as { name: string | null } | null)?.name ?? null,
      edited_at: (r.edited_at as string | null) ?? null,
      edited_by_name: (r.editor as { name: string | null } | null)?.name ?? null,
      proof_image_url: (r.proof_image_url as string | null) ?? null,
      proof_image_width: (r.proof_image_width as number | null) ?? null,
      proof_image_height: (r.proof_image_height as number | null) ?? null,
    }));

    void saveApportsCache(businessId, apports as unknown[]);
    if (isStaleBusiness(businessId)) return;
    set({ apports, loading: false, offline: false, offlineSince: null });
  },

  addApport: async ({ businessId, amount, injectedById, sourceName, note, injectedAt }) => {
    set({ saving: true, error: null });

    const { data, error } = await supabase.rpc('record_injection', {
      p_business_id:    businessId,
      p_amount:         Math.round(amount * 100),
      p_injected_by_id: injectedById ?? null,
      p_source_name:    sourceName ?? null,
      p_note:           note ?? null,
      p_injected_at:    injectedAt,
    });

    if (error) {
      set({ saving: false, error: translateError(error, 'Impossible d\'enregistrer') });
      return null;
    }

    set({ saving: false });
    await get().fetchApports(businessId);
    return (data as string) ?? null;
  },

  editApport: async ({ id, businessId, amount, injectedById, sourceName, note, injectedAt }) => {
    set({ saving: true, error: null });

    const { error } = await supabase.rpc('edit_injection', {
      p_id:             id,
      p_amount:         Math.round(amount * 100),
      p_injected_by_id: injectedById ?? null,
      p_source_name:    sourceName ?? null,
      p_note:           note ?? null,
      p_injected_at:    injectedAt,
    });

    if (error) {
      set({ saving: false, error: translateError(error, 'Impossible de modifier') });
      return false;
    }

    set({ saving: false });
    await get().fetchApports(businessId);
    return true;
  },

  recordWithdrawal: async ({ businessId, amount, injectedById, sourceName, note, withdrawnAt }) => {
    set({ saving: true, error: null });

    const { data, error } = await supabase.rpc('record_withdrawal', {
      p_business_id:    businessId,
      p_amount:         Math.round(amount * 100),
      p_injected_by_id: injectedById ?? null,
      p_source_name:    sourceName ?? null,
      p_note:           note ?? null,
      p_withdrawn_at:   withdrawnAt,
    });

    if (error) {
      set({ saving: false, error: translateError(error, 'Impossible d\'enregistrer le retrait') });
      return null;
    }

    set({ saving: false });
    await get().fetchApports(businessId);
    return (data as string) ?? null;
  },

  reset: () => set({ apports: [], loading: false, saving: false, error: null, offline: false, offlineSince: null }),
}));
