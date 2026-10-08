import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { isOutboxValidationError } from '@/lib/outboxValidation';
import { generateId } from '@/lib/id';
import {
  enqueue, getQueueCount, saveExpenseCache, getExpenseCache, getCacheTimestamp,
  getAllQueueItemsForOverlay, cancelPendingQueueItems,
} from '@/lib/db';
import { isNetworkError, withTimeout, withNetworkRetry, reportOfflineFallback } from '@/lib/sync';
import { applyExpenseOverlay, EXPENSE_QUEUE_OPS, type QueuedExpenseOp } from '@/lib/expenseOverlay';
import { useSyncStore } from '@/stores/sync';
import { useProductStore } from '@/stores/products';
import { notifyEvent } from '@/src/utils/notifications';
import { useAuthStore } from '@/stores/auth';
import { formatAmount } from '@/src/utils/format';
import type { Expense, ExpenseStatus } from '@/src/types';

// See stores/products.ts for the full explanation.
function isStaleBusiness(businessId: string): boolean {
  return useAuthStore.getState().session?.activeBusiness?.id !== businessId;
}

export interface CreateExpenseData {
  amount: number;
  description: string;
  category?: string | null;
  date: string;
  due_date?: string | null;
  note?: string | null;
  product_id?: string | null;
}

// Rows removed by a delete that can still be undone. `cancelledCreates` holds
// the create payload of an expense deleted before it ever synced: its queued
// create was cancelled, so undoing the delete has to queue it again.
const snapshots = new Map<string, Expense>();
const cancelledCreates = new Map<string, Record<string, unknown>>();

const ALL_EXPENSE_OPS = Array.from(EXPENSE_QUEUE_OPS);

async function readExpenseOps(): Promise<(QueuedExpenseOp & { id: string | null; status: string })[]> {
  try {
    const { ok } = await getAllQueueItemsForOverlay();
    const out: (QueuedExpenseOp & { id: string | null; status: string })[] = [];
    for (const item of ok) {
      if (!EXPENSE_QUEUE_OPS.has(item.operation) || item.status === 'failed_permanent') continue;
      try {
        out.push({ operation: item.operation, payload: JSON.parse(item.payload), id: item.idempotency_key, status: item.status });
      } catch { /* unreadable row: skipped, the drainer reports it as corrupt */ }
    }
    return out;
  } catch {
    return [];
  }
}

function overlayContext() {
  const productNames: Record<string, string> = {};
  for (const p of useProductStore.getState().products) productNames[p.id] = p.name;
  return {
    productNames,
    creatorName: useAuthStore.getState().session?.user.name || 'Vous',
    snapshots,
  };
}

function toPayload(businessId: string, userId: string, data: CreateExpenseData, status: string, id: string) {
  return {
    id,
    business_id: businessId,
    amount: Math.round(data.amount * 100),
    description: (data.description ?? '').trim(),
    category: data.category?.trim() || null,
    date: data.date,
    due_date: data.due_date || null,
    note: data.note?.trim() || null,
    product_id: data.product_id ?? null,
    status,
    created_by: userId,
  };
}

interface ExpensesStore {
  // Server truth (or its cache); `expenses` = baseline + still-queued local ops.
  baseline: Expense[];
  expenses: Expense[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  offline: boolean;
  offlineSince: number | null;

  fetchExpenses: (businessId: string) => Promise<void>;
  // Returns the new expense id (both online and offline-queued) so a photo
  // picked during creation can be attached to it; null on hard failure.
  createExpense: (businessId: string, userId: string, data: CreateExpenseData, isManager: boolean) => Promise<string | null>;
  updateExpense: (id: string, businessId: string, data: CreateExpenseData) => Promise<boolean>;
  // Soft delete (never a hard delete). Also the code path behind "Annuler" on a
  // just-created expense. restoreExpense is the undo of a delete.
  deleteExpense: (id: string, businessId: string) => Promise<boolean>;
  restoreExpense: (id: string, businessId: string) => Promise<boolean>;
  approveExpense: (id: string, userId: string) => Promise<boolean>;
  rejectExpense: (id: string, userId: string) => Promise<boolean>;
  clearError: () => void;
  reset: () => void;
}

export const useExpensesStore = create<ExpensesStore>((set, get) => {
  // Re-derives the shown list from the untouched baseline + the durable outbox.
  const rebuild = async (businessId: string) => {
    const ops = await readExpenseOps();
    if (isStaleBusiness(businessId)) return;
    set({ expenses: applyExpenseOverlay(get().baseline, ops, overlayContext()) });
  };
  // Durable write already happened; this only refreshes counters and nudges the drainer.
  const afterEnqueue = async () => {
    try {
      useSyncStore.setState({ pendingCount: await getQueueCount() });
    } catch { /* counter only */ }
    useSyncStore.getState().kick();
  };

  const decideExpense = async (
  operation: 'approve_expense' | 'reject_expense',
  status: ExpenseStatus,
  id: string,
  userId: string,
): Promise<boolean> => {
  set({ saving: true, error: null });
  const expense = get().expenses.find(e => e.id === id);
  const businessId = expense?.business_id ?? useAuthStore.getState().session?.activeBusiness?.id;
  const patch = { status, approved_by: userId, approved_at: new Date().toISOString() };
  try {
    await enqueue(operation, { id, ...patch });
    if (businessId) await rebuild(businessId);
    set({ saving: false });
    void afterEnqueue();
    return true;
  } catch (err) {
    // failure: speaks — the local write itself failed (storage), nothing was queued
    set({
      saving: false,
      error: isOutboxValidationError(err) ? null : translateError(err, operation === 'approve_expense' ? "Impossible d'approuver la dépense" : 'Impossible de rejeter la dépense'),
    });
    return false;
  }
}

  return ({
  baseline: [],
  expenses: [],
  loading: false,
  saving: false,
  error: null,
  offline: false,
  offlineSince: null,

  fetchExpenses: async (businessId) => {
    set({ loading: true, error: null });
    try {
      const { data, error } = await withNetworkRetry(() =>
        supabase
          .from('expenses')
          .select('*, product:products(name)')
          .eq('business_id', businessId)
          .order('date', { ascending: false })
          .order('created_at', { ascending: false }),
      );

      if (error) throw error;
      if (isStaleBusiness(businessId)) return;

      const expenses = (data ?? []) as Expense[];
      const fromCents = (e: Expense) => ({ ...e, amount: e.amount / 100 });

      const creatorIds = [...new Set(expenses.map(e => e.created_by))];
      let result: Expense[];
      if (creatorIds.length > 0) {
        // Best-effort enrichment — a hang or failure here must never block
        // the main list (which already fetched successfully) from ever
        // clearing `loading`. See CLAUDE.md's "withTimeout() sweep" note.
        let profiles: { id: string; name: string }[] | null = null;
        try {
          const res = await withTimeout(
            supabase.from('profiles').select('id, name').in('id', creatorIds),
          );
          profiles = res.data as { id: string; name: string }[] | null;
        } catch {
          profiles = null;
        }

        const pm: Record<string, string> = {};
        for (const p of (profiles ?? [])) pm[p.id] = p.name;

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
      if (isStaleBusiness(businessId)) return;
      const ops = await readExpenseOps();
      if (isStaleBusiness(businessId)) return;
      set({
        baseline: result,
        expenses: applyExpenseOverlay(result, ops, overlayContext()),
        loading: false, offline: false, offlineSince: null,
      });
    } catch (err) {
      if (isNetworkError(err)) {
        reportOfflineFallback('expenses.fetchExpenses', err);
        const cached = await getExpenseCache(businessId) as Expense[] | null;
        if (isStaleBusiness(businessId)) return;
        if (cached) {
          const ts = await getCacheTimestamp('expense_cache', businessId);
          if (isStaleBusiness(businessId)) return;
          const ops = await readExpenseOps();
          if (isStaleBusiness(businessId)) return;
          set({
            baseline: cached,
            expenses: applyExpenseOverlay(cached, ops, overlayContext()),
            loading: false, offline: true, offlineSince: ts, error: null,
          });
          return;
        }
        set({
          error: 'Pas de connexion. Ouvrez l\'application en ligne une première fois pour activer le mode hors ligne.',
          loading: false,
          offline: true,
        });
        return;
      }
      if (isStaleBusiness(businessId)) return;
      set({ error: translateError(err, "Le chargement n'a pas abouti."), loading: false });
    }
  },

  createExpense: async (businessId, userId, data, isManager) => {
    set({ saving: true, error: null });
    const payload = toPayload(businessId, userId, data, isManager ? 'approuve' : 'en_attente', generateId());
    try {
      await enqueue('create_expense', payload);
      await rebuild(businessId);
      set({ saving: false });
      void afterEnqueue();
      return payload.id;
    } catch (err) {
      // failure: speaks — the local write itself failed (storage), nothing was queued
      set({ error: isOutboxValidationError(err) ? null : translateError(err, "Impossible d'enregistrer la dépense"), saving: false });
      return null;
    }
  },

  updateExpense: async (id, businessId, data) => {
    set({ saving: true, error: null });
    const full = toPayload(businessId, '', data, 'approuve', id);
    const { business_id: _b, created_by: _c, status: _s, id: _i, ...patch } = full;
    try {
      // An edit of an expense that has not synced yet just rewrites its queued
      // create: one row to send, no pointless create-then-update pair.
      const ops = await readExpenseOps();
      const queuedCreate = ops.find(o => o.operation === 'create_expense' && o.id === id && o.status === 'pending');
      if (queuedCreate && !useSyncStore.getState().syncing) {
        const merged = { ...queuedCreate.payload, ...patch };
        await cancelPendingQueueItems(['create_expense', 'update_expense'], id);
        await enqueue('create_expense', merged);
      } else {
        await enqueue('update_expense', { id, ...patch });
      }
      await rebuild(businessId);
      set({ saving: false });
      void afterEnqueue();
      return true;
    } catch (err) {
      // failure: speaks — local write failed
      set({ error: isOutboxValidationError(err) ? null : translateError(err, 'Impossible de mettre à jour la dépense'), saving: false });
      return false;
    }
  },

  deleteExpense: async (id, businessId) => {
    try {
      const shown = get().expenses.find(e => e.id === id);
      if (shown) snapshots.set(id, shown);
      const ops = await readExpenseOps();
      const queuedCreate = ops.find(o => o.operation === 'create_expense' && o.id === id && o.status === 'pending');
      if (queuedCreate && !useSyncStore.getState().syncing) {
        // Never reached the server: cancel the queued op instead of queueing its opposite.
        await cancelPendingQueueItems(ALL_EXPENSE_OPS, id);
        cancelledCreates.set(id, queuedCreate.payload);
        // Make sure the overlay no longer shows it even though nothing is queued.
        set(state => ({ expenses: state.expenses.filter(e => e.id !== id) }));
      } else {
        await enqueue('delete_expense', { p_expense_id: id });
      }
      await rebuild(businessId);
      set(state => ({ expenses: state.expenses.filter(e => e.id !== id) }));
      void afterEnqueue();
      return true;
    } catch (err) {
      // failure: speaks — local write failed
      set({ error: isOutboxValidationError(err) ? null : translateError(err, 'Impossible de supprimer la dépense') });
      return false;
    }
  },

  restoreExpense: async (id, businessId) => {
    try {
      const recreate = cancelledCreates.get(id);
      if (recreate) {
        await enqueue('create_expense', recreate);
        cancelledCreates.delete(id);
      } else {
        const cancelled = useSyncStore.getState().syncing
          ? 0
          : await cancelPendingQueueItems(['delete_expense'], id);
        if (!cancelled) await enqueue('restore_expense', { p_expense_id: id });
      }
      // The row must be back in the baseline for the overlay to show it again.
      const back = snapshots.get(id);
      if (back && !get().baseline.some(e => e.id === id) && !recreate) {
        set(state => ({ baseline: [back, ...state.baseline] }));
      }
      await rebuild(businessId);
      void afterEnqueue();
      return true;
    } catch (err) {
      // failure: speaks — local write failed
      set({ error: isOutboxValidationError(err) ? null : translateError(err, 'Impossible de rétablir la dépense') });
      return false;
    }
  },

  // approve / reject — phone-first like every other expense write: the decision
  // is recorded in the outbox instantly (the overlay shows it at once, any
  // network), replayed later; the creator is notified when it reaches the server.
  approveExpense: async (id, userId) => decideExpense('approve_expense', 'approuve', id, userId),

  rejectExpense: async (id, userId) => decideExpense('reject_expense', 'rejete', id, userId),

  clearError: () => set({ error: null }),
  reset: () => { snapshots.clear(); cancelledCreates.clear(); set({ baseline: [], expenses: [], loading: false, saving: false, error: null, offline: false, offlineSince: null }); },
  });
});
