// Réception history, base + outbox. A confirmed réception sits in the outbox
// until it drains; until then the supplier's history ("commandes") must already
// show it, or the vendor sees a delivery she just confirmed vanish.
//
// Pure and recomputed, never patched: `base` is the last server list (or its
// cache) and is never mutated; every call re-folds the CURRENT pending
// confirm_reception ops onto it in queue (FIFO) order. A row the server already
// has (same id) is not projected again, so a finishing drain can't double it.
import type { CommandeAchat, CommandeLigne } from '@/stores/fournisseurs';

export interface QueuedReceptionOp {
  operation: string;
  payload: string;
  status: string;
  queued_at: string | null;
}

interface ReceptionLinePayload {
  product_id: string | null;
  variant_id: string | null;
  name: string;
  qty: number;
  unit_cost_cents: number | null;
}

export function applyReceptionOps(
  base: CommandeAchat[],
  ops: QueuedReceptionOp[],
  businessId: string,
  supplierName: (supplierId: string | null) => string,
): CommandeAchat[] {
  let list = base.map(c => ({ ...c }));
  for (const op of ops) {
    if (op.operation !== 'confirm_reception' || op.status !== 'pending') continue;
    let p: Record<string, unknown>;
    try { p = JSON.parse(op.payload); } catch { continue; }
    if (p.p_business_id !== businessId) continue;

    const key = p.p_idempotency_key as string;
    const poId = (p.p_po_id as string | null) ?? null;
    const orderId = poId ?? key;
    const supplierId = (p.p_supplier_id as string | null) ?? null;
    const when = (p.p_received_date as string | null) ?? op.queued_at ?? new Date().toISOString();
    const rows = (Array.isArray(p.p_lines) ? p.p_lines : []) as ReceptionLinePayload[];
    const lines: CommandeLigne[] = rows.map((l, i) => ({
      id: `${orderId}:${i}`,
      po_id: orderId,
      product_id: l.product_id ?? '',
      product_name: l.name,
      variant_id: l.variant_id ?? null,
      variant_name: null,
      qty_ordered: l.qty,
      qty_received: l.qty,
      unit_cost: l.unit_cost_cents == null ? null : l.unit_cost_cents / 100,
    }));
    const goods = rows.reduce((s, l) => s + l.qty * (l.unit_cost_cents ?? 0), 0);
    const total = (goods + ((p.p_transport_cost_cents as number | undefined) ?? 0)) / 100;

    const existing = list.find(c => c.id === orderId);
    if (existing && !existing._pending) {
      // Closing an order the list already has (Porte 2): flip it, keep its own data.
      if (existing.status === 'recu') continue; // the server already knows
      list = list.map(c => (c.id === orderId
        ? { ...c, status: 'recu', received_at: when, lines: c.lines ?? lines, _pending: true }
        : c));
    } else if (!existing) {
      list.unshift({
        id: orderId,
        business_id: businessId,
        supplier_id: supplierId ?? '',
        supplier_name: supplierName(supplierId),
        status: 'recu',
        ordered_at: when,
        received_at: when,
        total_cost: total,
        lines,
        _pending: true,
      });
    }
  }
  return list.sort((a, b) => (b.ordered_at ?? '').localeCompare(a.ordered_at ?? ''));
}
