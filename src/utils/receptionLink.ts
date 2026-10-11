// How a delivery (réception) line becomes a product — the rules, kept pure so they are testable.
//
// There is exactly ONE way to add a product (the QuickAddProductSheet). A delivery line is either linked
// to an existing product, or to one created through that sheet; it NEVER becomes a product at confirm.

import { formatAmountInput } from '@/src/utils/format';
import type { QuickAddPayload } from '@/src/utils/quickAddProduct';

export interface LineLike {
  localId: string;
  name: string;
  product_id: string | null;
}

/** A line with a typed name that is not linked to any product. Must be resolved before confirm. */
export function isUnlinkedNamedLine(l: Pick<LineLike, 'name' | 'product_id'>): boolean {
  return l.name.trim().length > 0 && !l.product_id;
}

export function unlinkedNamedLines<T extends LineLike>(lines: T[]): T[] {
  return lines.filter(isUnlinkedNamedLine);
}

export interface CreatedVariant { id: string; name: string }

export interface LinkedLinePatch {
  product_id: string;
  name: string;
  hasVariants: boolean;
  variantSplits: { variant_id: string; name: string; qty: string }[] | null;
  qty: string;
  /** "Je vends à" comes from the sheet and is BOOKED at confirm (touched), not a hint. */
  salePriceInput: string;
  salePriceCents: number;
  salePriceTouched: true;
}

/**
 * What to write onto the delivery line once the sheet created its product. The line keeps its own
 * unit cost (not part of this patch). Quantity comes from the sheet (prefilled from the line); with
 * Modèles the line takes the per-model split typed in the sheet, using the created models' ids, so it
 * goes through the same per-model path as an existing variant product.
 */
export function linkedLinePatch(args: {
  productId: string;
  payload: QuickAddPayload;
  createdVariants: CreatedVariant[];
  fallbackQty: string;
  currency: string;
}): LinkedLinePatch {
  const { productId, payload, createdVariants, fallbackQty, currency } = args;
  const price = payload.data.sale_price;
  const base = {
    product_id: productId,
    name: payload.data.name,
    salePriceInput: formatAmountInput(String(Math.round(price)), currency),
    salePriceCents: Math.round(price * 100),
    salePriceTouched: true as const,
  };
  if (payload.hasVariants && createdVariants.length > 0) {
    const splits = createdVariants.map(v => {
      const typed = payload.deliverySplits?.find(sp => sp.name === v.name)?.qty ?? 0;
      return { variant_id: v.id, name: v.name, qty: typed > 0 ? String(typed) : '' };
    });
    const total = splits.reduce((sum, v) => sum + (v.qty ? Number(v.qty) : 0), 0);
    return { ...base, hasVariants: true, variantSplits: splits, qty: total > 0 ? String(total) : fallbackQty };
  }
  const q = payload.deliveryQty;
  return { ...base, hasVariants: false, variantSplits: null, qty: q && q > 0 ? String(q) : fallbackQty };
}
