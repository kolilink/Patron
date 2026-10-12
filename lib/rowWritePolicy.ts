// Pure (no imports): what the generic `row_write` outbox operation may touch.
// Consumed by lib/outboxValidation.ts (before SQLite) and lib/sync.ts (the drain).
//
// Conflict policy by cost of being wrong:
//   - MONEY paths (sales, debts, payments, expenses, stock, deliveries, supplier money) are NEVER row writes:
//     they go through dedicated RPC operations with a server-claimed idempotency key (strict).
//   - DISPLAY fields (names, phones, notes, preferences) are last-writer-wins: the outbox drains FIFO and
//     every row_write is an idempotent update/upsert, so the newest queued value ends up on the server.
//   - LINKS (product_suppliers) are set-membership: a duplicate insert / already-gone delete counts as success.

export type RowWriteOp = 'insert' | 'update' | 'upsert' | 'delete';

export interface RowWriteTablePolicy {
  conflict: 'display-lww' | 'link';
  ops: readonly RowWriteOp[];
  /** Columns a payload's `values` may carry. */
  columns: readonly string[];
  /** Columns that must be present in `match` (update/delete). */
  matchKeys: readonly string[];
  onConflict?: string;
}

export const ROW_WRITE_TABLES: Record<string, RowWriteTablePolicy> = {
  profiles: { conflict: 'display-lww', ops: ['update'], columns: ['name', 'notify_on_every_sale', 'debt_reminders_enabled'], matchKeys: ['id'] },
  businesses: { conflict: 'display-lww', ops: ['update'], columns: ['name', 'phone', 'currency'], matchKeys: ['id'] },
  clients: {
    conflict: 'display-lww', ops: ['upsert', 'insert', 'update'],
    columns: ['id', 'business_id', 'name', 'phone', 'notes', 'created_by', 'updated_at'], matchKeys: ['id'], onConflict: 'business_id,name',
  },
  product_suppliers: { conflict: 'link', ops: ['insert', 'delete'], columns: ['product_id', 'supplier_id'], matchKeys: ['product_id', 'supplier_id'] },
};

/** Well-formedness problems of a row_write payload (empty = OK). */
export function rowWriteProblems(payload: unknown): string[] {
  const p: string[] = [];
  const o = payload as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return ['payload must be an object'];
  const policy = typeof o.table === 'string' && Object.prototype.hasOwnProperty.call(ROW_WRITE_TABLES, o.table) ? ROW_WRITE_TABLES[o.table] : null;
  if (!policy) return [`table "${String(o.table)}" is not a row_write table (money tables use their own operations)`];
  if (typeof o.op !== 'string' || !policy.ops.includes(o.op as RowWriteOp)) p.push(`op "${String(o.op)}" not allowed on ${o.table}`);
  if (typeof o.p_idempotency_key !== 'string' || o.p_idempotency_key.length < 8) p.push('p_idempotency_key is required');
  const values = o.values;
  if (o.op !== 'delete') {
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values as object).length === 0) p.push('values must be a non-empty object');
    else for (const k of Object.keys(values as object)) if (!policy.columns.includes(k)) p.push(`column "${k}" not allowed on ${o.table}`);
  }
  if (o.op === 'update' || o.op === 'delete') {
    const m = o.match as Record<string, unknown> | undefined;
    if (!m || typeof m !== 'object') p.push('match is required');
    else for (const k of policy.matchKeys) if (m[k] === undefined || m[k] === null || m[k] === '') p.push(`match.${k} is required`);
  }
  return p;
}

/**
 * Every kind of write in the app, classified. A write NOT in the funnel must be in EXEMPT with a reason;
 * "it's easier direct" is never a reason. Qualification test: "if the network dropped right now, would the
 * vendor be upset to lose this?" — yes → funnel.
 */
export const WRITE_CLASSES = {
  money_strict: ['submit_sale', 'submit_quick_sale', 'submit_carnet_debt', 'record_payment', 'record_client_payment', 'cancel_sale',
    'create_expense', 'update_expense', 'delete_expense', 'restore_expense', 'approve_expense', 'reject_expense',
    'confirm_reception', 'pay_supplier_debt', 'create_supplier_debt', 'adjust_stock_move', 'adjust_stock'],
  display_lww: ['create_product', 'update_product', 'create_supplier', 'update_supplier', 'row_write:profiles', 'row_write:businesses', 'row_write:clients'],
  links: ['row_write:product_suppliers'],
  exempt: {
    chat_messages: 'realtime-ephemeral: chat needs a connection and she knows it',
    chat_room_reads: 'notification read marker (local-only UI state mirrored to the server)',
    'profiles.unread_notification_count': 'notification read marker (badge counter reset)',
    auth_session_plumbing: 'auth/session: profiles upsert at signup/login, pending_deletion_at, onboarding stamps — need a live session by construction',
  },
} as const;
