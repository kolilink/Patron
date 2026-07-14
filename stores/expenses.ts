import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { generateId } from '@/lib/id';
import { enqueue, getQueueCount, saveExpenseCache, getExpenseCache, getCacheTimestamp } from '@/lib/db';
import { isNetworkError } from '@/lib/sync';
import { useSyncStore } from '@/stores/sync';
import { notifyEvent } from '@/src/utils/notifications';
import { useAuthStore } from '@/stores/auth';
import { formatAmount } from '@/src/utils/format';
import type { Expense, ExpenseStatus } from '@/src/types';

export interface CreateExpenseData {
  amount: number;
  description: string;
  category?: string | null;
  date: string;
  due_date?: string | null;
  note?: string | null;
  product_id?: string | null;
}

interface ExpensesStore {
  expenses: Expense[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  offline: boolean;
  offlineSince: number | null;

  fetchExpenses: (businessId: string) => Promise<void>;
  createExpense: (businessId: string, userId: string, data: CreateExpenseData, isManager: boolean) => Promise<boolean>;
  updateExpense: (id: string, businessId: string, data: CreateExpenseData) => Promise<boolean>;
  approveExpense: (id: string, userId: string) => Promise<boolean>;
  rejectExpense: (id: string, userId: string) => Promise<boolean>;
  clearError: () => void;
  reset: () => void;
}

export const useExpensesStore = create<ExpensesStore>((set, get) => ({
  expenses: [],
  loading: false,
  saving: false,
  error: null,
  offline: false,
  offlineSince: null,

  fetchExpenses: async (businessId) => {
    set({ loading: true, error: null });
    try {
      const { data, error } = await supabase
        .from('expenses')
        .select('*, product:products(name)')
        .eq('business_id', businessId)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false });

      if (error) throw error;

      const expenses = (data ?? []) as Expense[];
      const fromCents = (e: Expense) => ({ ...e, amount: e.amount / 100 });

      const creatorIds = [...new Set(expenses.map(e => e.created_by))];
      let result: Expense[];
      if (creatorIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, name')
          .in('id', creatorIds);

        const pm: Record<string, string> = {};
        for (const p of (profiles ?? [])) pm[(p as { id: string; name: string }).id] = (p as { id: string; name: string }).name;

        result = expenses.map(e => ({
          ...fromCents(e),
          creator_name: pm[e.created_by] ?? 'Inconnu',
          product_name: (e as any).product?.name ?? null,
        }));
      } else {
        result = expenses.map(e => ({
          ...fromCents(e),
          product_name: (e as any).product?.name ?? null,
        }));
      }
      void saveExpenseCache(businessId, result as unknown[]);
      set({ expenses: result, loading: false, offline: false, offlineSince: null });
    } catch (err) {
      if (isNetworkError(err)) {
        const cached = await getExpenseCache(businessId) as Expense[] | null;
        if (cached) {
          const ts = await getCacheTimestamp('expense_cache', businessId);
          set({ expenses: cached, loading: false, offline: true, offlineSince: ts, error: null });
          return;
        }
        set({
          error: 'Pas de connexion. Ouvrez l\'application en ligne une première fois pour activer le mode hors ligne.',
          loading: false,
          offline: true,
        });
        return;
      }
      set({ error: translateError(err, 'Erreur de chargement'), loading: false });
    }
  },

  createExpense: async (businessId, userId, data, isManager) => {
    set({ saving: true, error: null });
    const payload = {
      id: generateId(),
      business_id: businessId,
      amount: Math.round(data.amount * 100),
      description: data.description.trim(),
      category: data.category?.trim() || null,
      date: data.date,
      due_date: data.due_date || null,
      note: data.note?.trim() || null,
      product_id: data.product_id ?? null,
      status: isManager ? 'approuve' : 'en_attente',
      created_by: userId,
    };
    try {
      const { error } = await supabase.from('expenses').insert(payload);
      if (error) throw error;
      await get().fetchExpenses(businessId);
      set({ saving: false });
      // Notify admins/managers when a vendeur submits an expense pending approval
      if (!isManager) {
        const _session = useAuthStore.getState().session;
        if (_session && !_session.isDemoMode) {
          const currency = _session.activeBusiness?.currency ?? 'GNF';
          notifyEvent({
            businessId,
            eventType: 'expense_submitted',
            payload: {
              name: _session.user.name || 'Vendeur',
              amount: formatAmount(data.amount, currency),
              description: data.description.trim(),
              expense_id: payload.id,   // needed for inline Valider/Refuser action
              business_id: businessId,
            },
            targetRoles: ['administrateur', 'manager'],
          });
        }
      }
      return true;
    } catch (err) {
      if (isNetworkError(err)) {
        await enqueue('create_expense', payload);
        const count = await getQueueCount();
        useSyncStore.setState({ pendingCount: count });
        set({ saving: false });
        return true;
      }
      set({ error: translateError(err, "Impossible d'enregistrer la dépense"), saving: false });
      return false;
    }
  },

  updateExpense: async (id, businessId, data) => {
    set({ saving: true, error: null });
    const patch = {
      amount: Math.round(data.amount * 100),
      description: data.description.trim(),
      category: data.category?.trim() || null,
      date: data.date,
      due_date: data.due_date || null,
      note: data.note?.trim() || null,
      product_id: data.product_id ?? null,
    };
    try {
      const { error } = await supabase.from('expenses').update(patch).eq('id', id);
      if (error) throw error;
      await get().fetchExpenses(businessId);
      set({ saving: false });
      return true;
    } catch (err) {
      if (isNetworkError(err)) {
        await enqueue('update_expense', { id, ...patch });
        const count = await getQueueCount();
        useSyncStore.setState({ pendingCount: count });
        // Optimistic in-memory update (display amount in whole units, not cents).
        set(state => ({
          expenses: state.expenses.map(e =>
            e.id === id ? { ...e, ...patch, amount: data.amount } : e,
          ),
          saving: false,
        }));
        const updated = get().expenses;
        void saveExpenseCache(businessId, updated as unknown[]);
        return true;
      }
      set({ error: translateError(err, 'Impossible de mettre à jour la dépense'), saving: false });
      return false;
    }
  },

  approveExpense: async (id, userId) => {
    set({ saving: true });
    const _expense = get().expenses.find(e => e.id === id);
    const now = new Date().toISOString();
    const patch = { status: 'approuve' as ExpenseStatus, approved_by: userId, approved_at: now };
    try {
      const { error } = await supabase.from('expenses').update(patch).eq('id', id);
      if (error) throw error;
      set(state => ({
        expenses: state.expenses.map(e => e.id === id ? { ...e, ...patch } : e),
        saving: false,
      }));
      if (_expense?.created_by && _expense.created_by !== userId) {
        const currency = useAuthStore.getState().session?.activeBusiness?.currency ?? 'GNF';
        notifyEvent({
          businessId: _expense.business_id,
          eventType: 'expense_approved',
          payload: { amount: formatAmount(_expense.amount, currency), description: _expense.description ?? '' },
          targetUserIds: [_expense.created_by],
        });
      }
      return true;
    } catch (err) {
      if (isNetworkError(err)) {
        await enqueue('approve_expense', { id, ...patch });
        const count = await getQueueCount();
        useSyncStore.setState({ pendingCount: count });
        set(state => ({
          expenses: state.expenses.map(e => e.id === id ? { ...e, ...patch } : e),
          saving: false,
        }));
        return true;
      }
      set({ saving: false, error: translateError(err, "Impossible d'approuver la dépense") });
      return false;
    }
  },

  rejectExpense: async (id, userId) => {
    set({ saving: true, error: null });
    const _expense = get().expenses.find(e => e.id === id);
    const now = new Date().toISOString();
    const patch = { status: 'rejete' as ExpenseStatus, approved_by: userId, approved_at: now };
    try {
      const { error } = await supabase.from('expenses').update(patch).eq('id', id);
      if (error) throw error;
      set(state => ({
        expenses: state.expenses.map(e => e.id === id ? { ...e, ...patch } : e),
        saving: false,
      }));
      if (_expense?.created_by && _expense.created_by !== userId) {
        const currency = useAuthStore.getState().session?.activeBusiness?.currency ?? 'GNF';
        notifyEvent({
          businessId: _expense.business_id,
          eventType: 'expense_rejected',
          payload: { amount: formatAmount(_expense.amount, currency), description: _expense.description ?? '' },
          targetUserIds: [_expense.created_by],
        });
      }
      return true;
    } catch (err) {
      if (isNetworkError(err)) {
        await enqueue('reject_expense', { id, ...patch });
        const count = await getQueueCount();
        useSyncStore.setState({ pendingCount: count });
        set(state => ({
          expenses: state.expenses.map(e => e.id === id ? { ...e, ...patch } : e),
          saving: false,
        }));
        return true;
      }
      set({ saving: false, error: translateError(err, 'Impossible de rejeter la dépense') });
      return false;
    }
  },

  clearError: () => set({ error: null }),
  reset: () => set({ expenses: [], loading: false, saving: false, error: null, offline: false, offlineSince: null }),
}));
