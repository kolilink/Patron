import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import type { Expense, ExpenseStatus } from '@/src/types';

function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

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
      const msg = err instanceof Error ? err.message : 'Erreur de chargement';
      set({ error: msg, loading: false });
    }
  },

  createExpense: async (businessId, userId, data, isManager) => {
    set({ saving: true, error: null });
    try {
      const { error } = await supabase.from('expenses').insert({
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
      });
      if (error) throw error;
      await get().fetchExpenses(businessId);
      set({ saving: false });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur';
      set({ error: msg, saving: false });
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
      const msg = err instanceof Error ? err.message : 'Erreur';
      set({ error: msg, saving: false });
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
    } catch {
      set({ saving: false });
      return false;
    }
  },

  rejectExpense: async (id, userId) => {
    set({ saving: true });
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
    } catch {
      set({ saving: false });
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));
