import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { generateId } from '@/lib/id';
import { enqueue, getQueueCount } from '@/lib/db';
import { isNetworkError } from '@/lib/sync';
import { useSyncStore } from '@/stores/sync';
import type { Expense, ExpenseStatus } from '@/src/types';

export interface CreateExpenseData {
  amount: number;
  description: string;
  category?: string | null;
  date: string;
  due_date?: string | null;
  note?: string | null;
}

interface ExpensesStore {
  expenses: Expense[];
  loading: boolean;
  saving: boolean;
  error: string | null;

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

  fetchExpenses: async (businessId) => {
    set({ loading: true, error: null });
    try {
      const { data, error } = await supabase
        .from('expenses')
        .select('*')
        .eq('business_id', businessId)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false });

      if (error) throw error;

      const expenses = (data ?? []) as Expense[];

      const creatorIds = [...new Set(expenses.map(e => e.created_by))];
      if (creatorIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, name')
          .in('id', creatorIds);

        const pm: Record<string, string> = {};
        for (const p of (profiles ?? [])) pm[(p as { id: string; name: string }).id] = (p as { id: string; name: string }).name;

        set({
          expenses: expenses.map(e => ({ ...e, creator_name: pm[e.created_by] ?? 'Inconnu' })),
          loading: false,
        });
      } else {
        set({ expenses, loading: false });
      }
    } catch (err) {
      set({ error: translateError(err, 'Erreur de chargement'), loading: false });
    }
  },

  createExpense: async (businessId, userId, data, isManager) => {
    set({ saving: true, error: null });
    const payload = {
      id: generateId(),
      business_id: businessId,
      amount: data.amount,
      description: data.description.trim(),
      category: data.category?.trim() || null,
      date: data.date,
      due_date: data.due_date || null,
      note: data.note?.trim() || null,
      status: isManager ? 'approuve' : 'en_attente',
      created_by: userId,
    };
    try {
      const { error } = await supabase.from('expenses').insert(payload);
      if (error) throw error;
      await get().fetchExpenses(businessId);
      set({ saving: false });
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
    try {
      const { error } = await supabase.from('expenses').update({
        amount: data.amount,
        description: data.description.trim(),
        category: data.category?.trim() || null,
        date: data.date,
        due_date: data.due_date || null,
        note: data.note?.trim() || null,
      }).eq('id', id);
      if (error) throw error;
      await get().fetchExpenses(businessId);
      set({ saving: false });
      return true;
    } catch (err) {
      set({ error: translateError(err, 'Impossible de mettre à jour la dépense'), saving: false });
      return false;
    }
  },

  approveExpense: async (id, userId) => {
    set({ saving: true });
    try {
      const { error } = await supabase
        .from('expenses')
        .update({ status: 'approuve', approved_by: userId, approved_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      set(state => ({
        expenses: state.expenses.map(e =>
          e.id === id ? { ...e, status: 'approuve' as ExpenseStatus, approved_by: userId, approved_at: new Date().toISOString() } : e,
        ),
        saving: false,
      }));
      return true;
    } catch (err) {
      set({ saving: false, error: translateError(err, "Impossible d'approuver la dépense") });
      return false;
    }
  },

  rejectExpense: async (id, userId) => {
    set({ saving: true, error: null });
    try {
      const { error } = await supabase
        .from('expenses')
        .update({ status: 'rejete', approved_by: userId, approved_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      set(state => ({
        expenses: state.expenses.map(e =>
          e.id === id ? { ...e, status: 'rejete' as ExpenseStatus } : e,
        ),
        saving: false,
      }));
      return true;
    } catch (err) {
      set({ saving: false, error: translateError(err, 'Impossible de rejeter la dépense') });
      return false;
    }
  },

  clearError: () => set({ error: null }),
  reset: () => set({ expenses: [], loading: false, saving: false, error: null }),
}));
