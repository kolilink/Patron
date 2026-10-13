// Product writes are recorded phone-first (create / edit / stock adjustment),
// then replayed from the outbox. Until a replay lands, the catalogue must show
// them: the server list (or its cache — always the BASE, never overlaid) has
// not seen them yet. This applies the still-queued product ops on top of a
// base list, recomputed on every read — never patched incrementally, so a
// refetch can't drop a pending change and nothing is ever applied twice.
//
// Pure (no imports of native modules) so it is unit-testable.
import type { Product, ProductVariant } from '@/src/types';

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

/** Units a queued submit_sale takes, summed per product (variant=false) or per variant id (variant=true). */
function soldQuantities(payload: Record<string, unknown>, variant: boolean): Map<string, number> {
  const out = new Map<string, number>();
  const cart = Array.isArray(payload.p_cart) ? (payload.p_cart as Array<Record<string, unknown>>) : [];
  for (const l of cart) {
    const hasVariant = typeof l.variant_id === 'string' && l.variant_id.length > 0;
    if (hasVariant !== variant) continue;
    const key = (hasVariant ? l.variant_id : l.product_id) as string | undefined;
    const q = num(l.qty);
    if (!key || !Number.isFinite(q) || q <= 0) continue;
    out.set(key, (out.get(key) ?? 0) + q);
  }
  return out;
}

export function applyProductOp(list: Product[], op: QueuedProductOp, now: string = new Date().toISOString(), pool: Product[] = []): Product[] {
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
      // Archive ("désactiver"): the product leaves the active list at once.
      if (patch.archived === true) return list.filter(x => x.id !== id);
      const disp = fromCentsPatch(patch);
      // Restore ("réactiver"): it comes back from wherever it currently lives (the archived list).
      if (patch.archived === false && !list.some(x => x.id === id)) {
        const back = pool.find(x => x.id === id);
        if (!back) return list;
        return [...list, { ...back, ...disp, archived: false } as Product].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
      }
      return list.map(x => (x.id === id ? { ...x, ...disp } : x));
    }
    case 'adjust_stock_move': {
      const id = p.p_product_id as string | undefined;
      if (!id) return list;
      const qty = Math.abs(num(p.p_qty)) || 0;
      const delta = p.p_type === 'entree' ? qty : -qty;
      return list.map(x => (x.id === id ? { ...x, stock_qty: Math.max(0, x.stock_qty + delta) } : x));
    }
    case 'submit_sale': {
      // A queued sale takes its plain-product lines off the shelf the moment it is written (variant lines
      // are projected by applyVariantSaleOps). Recomputed from the outbox like every other op — never patched.
      const sold = soldQuantities(p, false);
      if (!sold.size) return list;
      return list.map(x => (sold.has(x.id) ? { ...x, stock_qty: Math.max(0, x.stock_qty - (sold.get(x.id) ?? 0)) } : x));
    }
    case 'cancel_sale': {
      // Stock comes back for the lines the cancelled sale carried (captured at enqueue time as _stock_lines;
      // a sale cancelled while still queued is netted out by normalizeStockOps instead).
      const back = soldQuantities({ p_cart: p._stock_lines }, false);
      if (!back.size) return list;
      return list.map(x => (back.has(x.id) ? { ...x, stock_qty: x.stock_qty + (back.get(x.id) ?? 0) } : x));
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

const isArchiveOp = (o: QueuedProductOp) =>
  o.operation === 'update_product' && typeof (o.payload as { archived?: unknown }).archived === 'boolean';

/**
 * Everything the phone knows about, before archive/restore is applied: the server list plus products
 * created or edited by still-queued ops. A product created offline and then archived/restored before
 * any sync exists ONLY here, so archive/restore must look it up in this set, not just the server lists.
 */
function knownProducts(base: Product[], ops: QueuedProductOp[], now?: string): Product[] {
  return ops.filter(o => !isArchiveOp(o)).reduce((list, op) => applyProductOp(list, op, now), base);
}

/** `archivedBase` is the server's "non actifs" list: a queued restore pulls its product back from it. */
export function applyPendingProductOps(base: Product[], ops: QueuedProductOp[], now?: string, archivedBase: Product[] = []): Product[] {
  const pool = [...archivedBase, ...knownProducts(base, ops, now)];
  return ops.reduce((list, op) => applyProductOp(list, op, now, pool), base);
}

/**
 * The "non actifs" list under the same ops: a queued archive adds the product (found among everything
 * known, including products created offline), a queued restore removes it. Recomputed from the base on
 * every read, like the active list.
 */
export function applyPendingArchived(archivedBase: Product[], activeBase: Product[], ops: QueuedProductOp[]): Product[] {
  const known = knownProducts(activeBase, ops);
  let list = archivedBase;
  for (const op of ops) {
    if (!isArchiveOp(op)) continue;
    const { id, archived } = op.payload as { id?: string; archived: boolean };
    if (!id) continue;
    if (archived) {
      if (list.some(x => x.id === id)) continue;
      const p = known.find(x => x.id === id);
      if (p) list = [...list, { ...p, archived: true } as Product].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    } else {
      list = list.filter(x => x.id !== id);
    }
  }
  return list;
}

/**
 * A sale cancelled while STILL queued never reached the server: both ops vanish (net zero), so stock simply
 * never moved. Cancelling an already-synced sale keeps its cancel_sale op, which restocks via _stock_lines.
 * Conservative direction: a cancel with no captured lines restores nothing (stock may read low, never high).
 */
export function normalizeStockOps(ops: QueuedProductOp[]): QueuedProductOp[] {
  const cancelled = new Set(ops.filter(o => o.operation === 'cancel_sale').map(o => String(o.payload.p_sale_id ?? '')));
  const pendingKeys = new Set(ops.filter(o => o.operation === 'submit_sale').map(o => String(o.payload.p_idempotency_key ?? '')));
  return ops.filter(o => {
    if (o.operation === 'submit_sale') return !cancelled.has(String(o.payload.p_idempotency_key ?? ''));
    if (o.operation === 'cancel_sale') return !pendingKeys.has(String(o.payload.p_sale_id ?? ''));
    return true;
  });
}

/** One product's variant list under the still-queued sales: each variant line takes its units, clamped at 0. */
export function applyVariantSaleOps(variants: ProductVariant[], productId: string, ops: QueuedProductOp[]): ProductVariant[] {
  return ops.reduce((list, op) => {
    const isSale = op.operation === 'submit_sale';
    if (!isSale && op.operation !== 'cancel_sale') return list;
    const raw = isSale ? op.payload.p_cart : op.payload._stock_lines;
    const cart = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
    const qty = soldQuantities({ p_cart: cart.filter(l => l.product_id === productId) }, true);
    if (!qty.size) return list;
    return list.map(v => (qty.has(v.id)
      ? { ...v, stock_qty: isSale ? Math.max(0, v.stock_qty - (qty.get(v.id) ?? 0)) : v.stock_qty + (qty.get(v.id) ?? 0) }
      : v));
  }, variants);
}
