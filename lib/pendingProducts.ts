// Product writes are recorded phone-first (create / edit / stock adjustment),
// then replayed from the outbox. Until a replay lands, the catalogue must show
// them: the server list (or its cache — always the BASE, never overlaid) has
// not seen them yet. This applies the still-queued product ops on top of a
// base list, recomputed on every read — never patched incrementally, so a
// refetch can't drop a pending change and nothing is ever applied twice.
//
// Pure (no imports of native modules) so it is unit-testable.
import type { Product } from '@/src/types';

export interface QueuedProductOp {
  operation: string;
  payload: Record<string, unknown>;
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));

function fromCentsPatch(patch: Record<string, unknown>): Partial<Product> {
  const out: Record<string, unknown> = { ...patch };
  if (patch.cost_price !== undefined) out.cost_price = num(patch.cost_price) / 100;
  if (patch.sale_price !== undefined) out.sale_price = num(patch.sale_price) / 100;
  if (patch.bulk_price !== undefined) out.bulk_price = patch.bulk_price != null ? num(patch.bulk_price) / 100 : null;
  return out as Partial<Product>;
}

export function applyProductOp(list: Product[], op: QueuedProductOp, now: string = new Date().toISOString()): Product[] {
  const p = op.payload;
  switch (op.operation) {
    case 'create_product': {
      const row = p.product as Record<string, unknown> | undefined;
      if (!row || typeof row.id !== 'string') return list;
      if (list.some(x => x.id === row.id)) return list; // already on the server list
      const created = {
        ...(row as object),
        ...fromCentsPatch(row),
        has_variants: false,
        created_at: now,
        updated_at: now,
      } as unknown as Product;
      return [...list, created].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    }
    case 'update_product': {
      const { id, ...patch } = p as { id?: string } & Record<string, unknown>;
      if (!id) return list;
      const disp = fromCentsPatch(patch);
      return list.map(x => (x.id === id ? { ...x, ...disp } : x));
    }
    case 'adjust_stock_move': {
      const id = p.p_product_id as string | undefined;
      if (!id) return list;
      const qty = Math.abs(num(p.p_qty)) || 0;
      const delta = p.p_type === 'entree' ? qty : -qty;
      return list.map(x => (x.id === id ? { ...x, stock_qty: Math.max(0, x.stock_qty + delta) } : x));
    }
    case 'adjust_stock': {
      // legacy shape: an absolute quantity
      const upd = p.productUpdate as { id?: string; stock_qty?: number } | undefined;
      if (!upd?.id || typeof upd.stock_qty !== 'number') return list;
      return list.map(x => (x.id === upd.id ? { ...x, stock_qty: upd.stock_qty as number } : x));
    }
    default:
      return list;
  }
}

export function applyPendingProductOps(base: Product[], ops: QueuedProductOp[], now?: string): Product[] {
  return ops.reduce((list, op) => applyProductOp(list, op, now), base);
}
