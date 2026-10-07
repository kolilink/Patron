// Supplier debt payments and supplier debt creation are recorded phone-first
// (outbox) and replayed later. Until a replay lands, the supplier screens must
// show them on top of the server lists (or their caches — always the BASE):
//   • create_supplier_debt → a new debt row;
//   • pay_supplier_debt    → the same oldest-first allocation the server does
//     (pay_supplier_debt, migration_v181/v243) + a payment row.
// Recomputed from base + queued ops on every read, never patched in place, so a
// refetch can't lose a pending change and nothing is applied twice.
//
// Pure (no native imports) so it is unit-testable.

export interface DebtRow {
  id: string;
  business_id: string;
  supplier_id: string;
  amount: number;       // display units
  amount_paid: number;  // display units
  description: string | null;
  date: string;
  created_at: string;
}

export interface PaymentRow {
  id: string;
  supplier_id: string;
  amount: number;       // display units
  paid_by: string;
  paid_at: string;
  note: string | null;
}

export interface QueuedSupplierOp {
  operation: string;
  payload: Record<string, unknown>;
  queuedAt: string;
}

const cents = (units: number) => Math.round(units * 100);

export function applyPendingSupplierOps(
  debts: DebtRow[],
  payments: PaymentRow[],
  ops: QueuedSupplierOp[],
  ctx: { userId: string },
): { debts: DebtRow[]; payments: PaymentRow[] } {
  let d = debts;
  let p = payments;
  for (const op of ops) {
    const pl = op.payload;
    if (op.operation === 'create_supplier_debt') {
      const id = pl.id as string | undefined;
      if (!id || d.some(x => x.id === id)) continue; // already on the server list
      d = [{
        id,
        business_id: pl.business_id as string,
        supplier_id: pl.supplier_id as string,
        amount: Number(pl.amount) / 100,
        amount_paid: 0,
        description: (pl.description as string | null) ?? null,
        date: (pl.date as string) ?? op.queuedAt.slice(0, 10),
        created_at: op.queuedAt,
      }, ...d];
    } else if (op.operation === 'pay_supplier_debt') {
      const supplierId = pl.p_supplier_id as string;
      let remaining = Number(pl.p_amount_cents) || 0;
      let allocated = 0;
      const oldestFirst = [...d]
        .filter(x => x.supplier_id === supplierId && cents(x.amount) > cents(x.amount_paid))
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const paidNow = new Map<string, number>();
      for (const debt of oldestFirst) {
        if (remaining <= 0) break;
        const pay = Math.min(remaining, cents(debt.amount) - cents(debt.amount_paid));
        paidNow.set(debt.id, pay);
        remaining -= pay;
        allocated += pay;
      }
      if (allocated <= 0) continue;
      d = d.map(x => (paidNow.has(x.id) ? { ...x, amount_paid: (cents(x.amount_paid) + (paidNow.get(x.id) as number)) / 100 } : x));
      p = [{
        id: (pl.p_idempotency_key as string) ?? `pending-${op.queuedAt}`,
        supplier_id: supplierId,
        amount: allocated / 100,
        paid_by: ctx.userId,
        paid_at: op.queuedAt,
        note: null,
      }, ...p];
    }
  }
  return { debts: d, payments: p };
}
