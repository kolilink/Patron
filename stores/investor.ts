import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { generateFallbackName } from '@/lib/id';
import { saveInvestorCache, getInvestorCache, getCacheTimestamp } from '@/lib/db';
import { isNetworkError, withNetworkRetry, reportOfflineFallback } from '@/lib/sync';
import { beginFetch, failFetch, IDLE, READY, type FetchStatus } from '@/lib/fetchStatus';

export interface InvestorPayout {
  id: string;
  business_id: string;
  investor_id: string;
  investor_name: string | null;
  requested_amount: number;  // display units (÷100)
  paid_amount: number | null;
  status: 'en_attente' | 'paye';
  requested_at: string;
  paid_at: string | null;
  paid_by_name: string | null;
}

interface InvestorStore {
  balance: number | null;       // display units (÷100), null = not loaded
  payouts: InvestorPayout[];
  loading: boolean;
  /** Payouts: idle → loading → ready | error. See lib/fetchStatus.ts. */
  fetchStatus: FetchStatus;
  /** The balance has its own status — `balance === null` means unknown, never zero. */
  balanceStatus: FetchStatus;
  saving: boolean;
  error: string | null;
  offline: boolean;
  offlineSince: number | null;

  fetchBalance: (businessId: string, investorId: string) => Promise<void>;
  fetchPayouts: (businessId: string, investorId?: string) => Promise<void>;
  requestPayout: (businessId: string, amountCents: bigint) => Promise<boolean>;
  confirmPayout: (payoutId: string, paidAmountCents: bigint) => Promise<boolean>;
  reset: () => void;
}

function balanceCacheKey(businessId: string, investorId: string) {
  return `balance:${businessId}:${investorId}`;
}
function payoutsCacheKey(businessId: string, investorId?: string) {
  return `payouts:${businessId}:${investorId ?? 'all'}`;
}

export const useInvestorStore = create<InvestorStore>((set, get) => ({
  balance: null,
  payouts: [],
  ...IDLE,
  balanceStatus: 'idle',
  saving: false,
  error: null,
  offline: false,
  offlineSince: null,

  fetchBalance: async (businessId, investorId) => {
    set({ balanceStatus: beginFetch(get().balanceStatus).fetchStatus, error: null });
    const { data, error } = await withNetworkRetry(() =>
      supabase
        .from('investor_balance')
        .select('balance')
        .eq('business_id', businessId)
        .eq('investor_id', investorId)
        .maybeSingle(),
    ).catch(err => ({ data: null, error: err }));

    if (error) {
      if (isNetworkError(error)) {
        reportOfflineFallback('investor.fetchBalance', error);
        const key = balanceCacheKey(businessId, investorId);
        const cached = await getInvestorCache(key);
        if (cached != null) {
          const ts = await getCacheTimestamp('investor_cache', key);
          set({ balance: cached as number, balanceStatus: 'ready', offline: true, offlineSince: ts });
          return;
        }
        set({ balanceStatus: 'ready', offline: true, offlineSince: null });
        return;
      }
      set({ balanceStatus: failFetch(get().balanceStatus).fetchStatus, error: translateError(error, 'Impossible de charger le solde') });
      return;
    }
    const balance = data ? (data.balance as number) / 100 : 0;
    set({ balance, balanceStatus: 'ready', offline: false, offlineSince: null });
    void saveInvestorCache(balanceCacheKey(businessId, investorId), balance);
  },

  fetchPayouts: async (businessId, investorId) => {
    set({ ...beginFetch(get().fetchStatus), error: null });

    let query = supabase
      .from('investor_payouts')
      .select('*, investor:profiles!investor_id(name, id), paid_by_profile:profiles!paid_by(name)')
      .eq('business_id', businessId)
      .order('requested_at', { ascending: false });

    if (investorId) {
      query = query.eq('investor_id', investorId);
    }

    const { data, error } = await withNetworkRetry(() => query).catch(err => ({ data: null, error: err }));

    if (error) {
      if (isNetworkError(error)) {
        reportOfflineFallback('investor.fetchPayouts', error);
        const key = payoutsCacheKey(businessId, investorId);
        const cached = await getInvestorCache(key);
        if (cached) {
          const ts = await getCacheTimestamp('investor_cache', key);
          set({ payouts: cached as InvestorPayout[], ...READY, offline: true, offlineSince: ts });
          return;
        }
        set({ ...READY, offline: true, offlineSince: null });
        return;
      }
      set({ ...failFetch(get().fetchStatus), error: translateError(error, 'Impossible de charger les retraits') });
      return;
    }

    const payouts: InvestorPayout[] = (data ?? []).map((r: Record<string, unknown>) => {
      const inv = r.investor as { name: string | null; id: string } | null;
      const paidBy = r.paid_by_profile as { name: string | null } | null;
      return {
        id: r.id as string,
        business_id: r.business_id as string,
        investor_id: r.investor_id as string,
        investor_name: inv?.name ?? (inv?.id ? generateFallbackName(inv.id) : null),
        requested_amount: (r.requested_amount as number) / 100,
        paid_amount: r.paid_amount != null ? (r.paid_amount as number) / 100 : null,
        status: r.status as 'en_attente' | 'paye',
        requested_at: r.requested_at as string,
        paid_at: (r.paid_at as string | null) ?? null,
        paid_by_name: paidBy?.name ?? null,
      };
    });

    set({ payouts, ...READY, offline: false, offlineSince: null });
    void saveInvestorCache(payoutsCacheKey(businessId, investorId), payouts);
  },

  requestPayout: async (businessId, amountCents) => {
    set({ saving: true, error: null });
    try {
      const { error } = await supabase.rpc('request_payout', {
        p_business_id: businessId,
        p_amount: Number(amountCents),
      });
      if (error) {
        set({ saving: false, error: translateError(error, 'Impossible de soumettre la demande') });
        return false;
      }
      set({ saving: false });
      await get().fetchPayouts(businessId);
      return true;
    } catch (err) {
      set({ saving: false, error: isNetworkError(err) ? 'Vérifiez votre connexion' : translateError(err, 'Impossible de soumettre la demande') });
      return false;
    }
  },

  confirmPayout: async (payoutId, paidAmountCents) => {
    set({ saving: true, error: null });
    try {
      const { error } = await supabase.rpc('confirm_payout', {
        p_payout_id: payoutId,
        p_paid_amount: Number(paidAmountCents),
      });
      if (error) {
        set({ saving: false, error: translateError(error, 'Impossible de confirmer le paiement') });
        return false;
      }
      set({ saving: false });
      return true;
    } catch (err) {
      set({ saving: false, error: isNetworkError(err) ? 'Vérifiez votre connexion' : translateError(err, 'Impossible de confirmer le paiement') });
      return false;
    }
  },

  reset: () => set({ balance: null, payouts: [], ...IDLE, balanceStatus: 'idle', saving: false, error: null, offline: false, offlineSince: null }),
}));
