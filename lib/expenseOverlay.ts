// Expense reads under the local-write-first model: shown list = server baseline
// + whatever the durable outbox still holds. Pure reducer (same idea as
// lib/pendingOverlay.ts for sales) — always recomputed from the untouched
// baseline, never patched incrementally, so a still-queued op can never be
// applied twice.
import type { Expense } from '@/src/types';

export interface QueuedExpenseOp {
  operation: string;
  payload: Record<string, unknown>;
}

export interface ExpenseOverlayContext {
  /** product id -> name, for the product line on a not-yet-synced row. */
  productNames: Record<string, string>;
  /** Name shown on rows this device created and the server has not echoed yet. */
  creatorName: string;
  /** Rows removed locally by delete_expense, kept so a queued restore can bring them back. */
  snapshots: Map<string, Expense>;
}

export const EXPENSE_QUEUE_OPS = new Set([
  'create_expense', 'update_expense', 'approve_expense', 'reject_expense',
  'delete_expense', 'restore_expense',
]);

const cents = (n: unknown) => Number(n ?? 0) / 100;

export function applyExpenseOverlay(
  baseline: Expense[],
  ops: QueuedExpenseOp[],
  ctx: ExpenseOverlayContext,
): Expense[] {
  let list = baseline.map(e => ({ ...e }));
  for (const { operation, payload } of ops) {
    switch (operation) {
      case 'create_expense': {
        const id = payload.id as string;
        if (list.some(e => e.id === id)) break;
        const now = new Date().toISOString();
        const productId = (payload.product_id as string | null) ?? null;
        list.unshift({
          id,
          business_id: payload.business_id as string,
          amount: cents(payload.amount),
          description: (payload.description as string) ?? '',
          category: (payload.category as string | null) ?? null,
          date: payload.date as string,
          due_date: (payload.due_date as string | null) ?? null,
          note: (payload.note as string | null) ?? null,
          status: payload.status as Expense['status'],
          created_by: payload.created_by as string,
          approved_by: null,
          approved_at: null,
          created_at: now,
          updated_at: now,
          creator_name: ctx.creatorName,
          product_id: productId,
          product_name: productId ? ctx.productNames[productId] ?? null : null,
        });
        break;
      }
      case 'update_expense': {
        const { id, ...patch } = payload as { id: string } & Record<string, unknown>;
        list = list.map(e => {
          if (e.id !== id) return e;
          const productId = (patch.product_id as string | null) ?? null;
          return {
            ...e,
            amount: cents(patch.amount),
            description: (patch.description as string) ?? e.description,
            category: (patch.category as string | null) ?? null,
            date: (patch.date as string) ?? e.date,
            due_date: (patch.due_date as string | null) ?? null,
            note: (patch.note as string | null) ?? null,
            product_id: productId,
            product_name: productId ? ctx.productNames[productId] ?? e.product_name ?? null : null,
          };
        });
        break;
      }
      case 'approve_expense':
      case 'reject_expense': {
        const { id, ...patch } = payload as { id: string } & Record<string, unknown>;
        list = list.map(e => (e.id === id ? ({ ...e, ...patch } as Expense) : e));
        break;
      }
      case 'delete_expense': {
        const id = payload.p_expense_id as string;
        const gone = list.find(e => e.id === id);
        if (gone) ctx.snapshots.set(id, gone);
        list = list.filter(e => e.id !== id);
        break;
      }
      case 'restore_expense': {
        const id = payload.p_expense_id as string;
        const back = ctx.snapshots.get(id);
        if (back && !list.some(e => e.id === id)) list.unshift(back);
        break;
      }
    }
  }
  return list;
}
