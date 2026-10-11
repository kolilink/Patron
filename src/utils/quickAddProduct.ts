// Pure logic behind QuickAddProductSheet (catalogue "+" flow). No React, no
// Supabase — everything the sheet prints or saves is derived here so it is
// unit-testable. Amounts are display units (GNF etc.), never cents.
//
// Rules this file owns:
//  - Validation is the old form's rule, unchanged: name required, sale price > 0.
//  - A model (variant) row whose price was never typed follows the starting
//    price ("prefilled"); typing into it marks it touched and it stops following.
//  - Toggling Modèles never loses what was typed: the single quantity becomes
//    the first row's quantity, and turning it off again gives the derived total
//    back as the single quantity.
//  - Fees are spread over the pieces bought (productPricing.perUnitCost) — the
//    merchant never divides.

import { perUnitCost, unitProfit } from '@/src/utils/productPricing';
import { formatAmountInput, parseAmountInput } from '@/src/utils/format';
import { parseQuantity } from '@/src/utils/quantity';
import type { Product, ProductVariant } from '@/src/types';
import type { CreateProductData, DraftVariant } from '@/stores/products';

export interface QuickVariant {
  key: string;
  name: string;
  /** Typed quantity text. */
  qty: string;
  /** Typed price text (already grouped by formatAmountInput). Ignored while !touched. */
  price: string;
  /** Has the merchant typed into this row's price? false → follows the starting price. */
  touched: boolean;
  /** Edit mode: an existing model. Its stock is a fact (changed via "Ajuster"), not an input. */
  locked?: boolean;
  /** Edit mode: the model's own purchase price (display units), kept when saving. */
  cost?: number;
}

export interface QuickAddState {
  name: string;
  /** "Je vends à" text. */
  price: string;
  /** Single-product quantity text (default "1"). */
  qty: string;
  models: boolean;
  variants: QuickVariant[];
  purchasePrice: string;
  fees: string;
  supplierId: string;
}

export const EMPTY_QUICK_ADD: QuickAddState = {
  name: '', price: '', qty: '1', models: false, variants: [],
  purchasePrice: '', fees: '', supplierId: '',
};

let keySeq = 0;
export function newVariantKey(): string {
  keySeq += 1;
  return `qv-${Date.now().toString(36)}-${keySeq}`;
}

export function makeQuickVariant(over: Partial<QuickVariant> = {}): QuickVariant {
  return { key: newVariantKey(), name: '', qty: '', price: '', touched: false, ...over };
}

// ── Validation ───────────────────────────────────────────────────────────────

export function nameValid(s: QuickAddState): boolean {
  return s.name.trim().length > 0;
}

export function priceValid(s: QuickAddState, currency: string): boolean {
  const sp = parseAmountInput(s.price, currency);
  return !isNaN(sp) && sp > 0;
}

/**
 * Rapid-loop rule: ONLY an empty name blocks. A product with no price is created with
 * sale_price 0 (the column is NOT NULL, so 0 is "not set") and shows "Prix à fixer".
 * `currency` is kept for call-site compatibility.
 */
export function validateQuickAdd(s: QuickAddState, _currency?: string): string | null {
  return nameValid(s) ? null : 'Indiquez le nom';
}

/** Ajouter is enabled exactly when the name is non-empty. */
export function canSubmit(s: QuickAddState): boolean {
  return nameValid(s);
}

// ── Models ───────────────────────────────────────────────────────────────────

/** Effective price of a row: its own once touched, otherwise the starting price. */
export function resolvedVariantPrice(v: QuickVariant, s: QuickAddState, currency: string): number {
  return v.touched ? parseAmountInput(v.price, currency) : parseAmountInput(s.price, currency);
}

export function variantQty(v: QuickVariant): number {
  return Math.max(Math.floor(parseQuantity(v.qty) ?? 0), 0);
}

/** "Total : X pièces" — derived, never editable. */
export function derivedTotalPieces(variants: QuickVariant[]): number {
  return variants.reduce((sum, v) => sum + variantQty(v), 0);
}

export function singleQty(s: QuickAddState): number {
  return Math.max(Math.floor(parseQuantity(s.qty) ?? 0), 0);
}

/** Pieces bought: the derived total with models, the stepper value without. */
export function piecesBought(s: QuickAddState): number {
  return s.models ? derivedTotalPieces(s.variants) : singleQty(s);
}

/**
 * Turn Modèles on/off without losing anything typed.
 * ON: the single quantity moves into the first row (rows start at the starting
 *     price, untouched = prefilled). Rows already there (toggled off then on) are kept.
 * OFF: the single quantity becomes the derived total; rows are kept so toggling
 *     back restores them.
 */
export function setModels(s: QuickAddState, on: boolean): QuickAddState {
  if (on === s.models) return s;
  if (on) {
    if (s.variants.length > 0) return { ...s, models: true };
    const first = makeQuickVariant({ qty: String(singleQty(s) || ''), name: '' });
    return { ...s, models: true, variants: [first] };
  }
  const total = derivedTotalPieces(s.variants);
  return { ...s, models: false, qty: String(total > 0 ? total : singleQty(s) || 1) };
}

export function addVariant(s: QuickAddState): QuickAddState {
  return { ...s, variants: [...s.variants, makeQuickVariant()] };
}

export function removeVariant(s: QuickAddState, key: string): QuickAddState {
  return { ...s, variants: s.variants.filter(v => v.key !== key) };
}

/** Typing a row's price marks it touched (so it stops following the starting price). */
export function patchVariant(s: QuickAddState, key: string, patch: Partial<QuickVariant>): QuickAddState {
  return {
    ...s,
    variants: s.variants.map(v => {
      if (v.key !== key) return v;
      const next = { ...v, ...patch };
      if (patch.price !== undefined) next.touched = true;
      return next;
    }),
  };
}

// ── Coût réel ────────────────────────────────────────────────────────────────

export interface CostLine {
  unitCost: number;
  /** Profit per piece at the starting price; null when no sale price yet. */
  profit: number | null;
}

/**
 * "Coût réel par pièce : X · Vous gagnez Y". Computable as soon as there is a
 * purchase price or fees; fees are spread over the pieces bought (at least 1).
 */
export function computeCostLine(s: QuickAddState, currency: string): CostLine | null {
  const pp = parseAmountInput(s.purchasePrice, currency) || 0;
  const fees = parseAmountInput(s.fees, currency) || 0;
  if (!(pp > 0) && !(fees > 0)) return null;
  const unitCost = perUnitCost(pp, fees, piecesBought(s));
  const sp = parseAmountInput(s.price, currency);
  return { unitCost, profit: !isNaN(sp) && sp > 0 ? unitProfit(sp, unitCost) : null };
}

// ── Save payload ─────────────────────────────────────────────────────────────

export interface QuickAddPayload {
  data: CreateProductData;
  hasVariants: boolean;
  variants: DraftVariant[];
}

/**
 * Same shape the old form handed to catalogue's handleSave. With models the
 * parent keeps stock 0 (documented invariant: stock lives on the variants).
 * A product born without a purchase price gets cost_price 0 — sellable at
 * once, completable later.
 */
/** What an edit must carry over from the stored product so saving never silently rewrites it. */
export interface ExistingProduct {
  reorder_level: number;
  unit: string;
  /** Stored landed cost (display units) — kept as-is unless the purchase price / fees were touched. */
  cost_price: number;
}

export function toQuickAddPayload(s: QuickAddState, currency: string, existing?: ExistingProduct): QuickAddPayload {
  // Nothing but the name may block, so a model row with no name is simply ignored; if no named
  // row is left the product is created as a plain product with the single quantity.
  const namedRows = s.models ? s.variants.filter(v => v.name.trim()) : [];
  if (s.models && namedRows.length === 0) s = { ...s, models: false };
  else if (s.models) s = { ...s, variants: namedRows };
  const fees = parseAmountInput(s.fees, currency) || 0;
  const pp = parseAmountInput(s.purchasePrice, currency) || 0;
  const pieces = piecesBought(s);
  const untouchedCost = !!existing && fees === 0 &&
    s.purchasePrice === (existing.cost_price > 0 ? formatAmountInput(String(Math.round(existing.cost_price)), currency) : '');
  const cost = untouchedCost ? existing!.cost_price : pp > 0 || fees > 0 ? perUnitCost(pp, fees, pieces) : 0;
  const data: CreateProductData = {
    name: s.name.trim(),
    unit: existing?.unit ?? 'pcs',
    cost_price: cost,
    sale_price: Math.max(parseAmountInput(s.price, currency) || 0, 0),
    reorder_level: existing?.reorder_level ?? 0,
    initial_stock: s.models ? 0 : singleQty(s),
    supplier_id: s.supplierId || null,
  };
  const variants: DraftVariant[] = s.models
    ? s.variants.map(v => ({
        name: v.name.trim(),
        sale_price: Math.max(resolvedVariantPrice(v, s, currency) || 0, 0),
        cost_price: v.cost ?? cost,
        stock_qty: variantQty(v),
        reorder_level: 0,
      }))
    : [];
  return { data, hasVariants: s.models, variants };
}

// ── Name autocomplete ────────────────────────────────────────────────────────

function fold(str: string): string {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

/** Existing products matching what she is typing (accent/case-insensitive, prefix matches first). */
export function suggestProducts(typed: string, products: Product[], limit = 3): Product[] {
  const q = fold(typed);
  if (q.length < 2) return [];
  const starts: Product[] = [];
  const contains: Product[] = [];
  for (const p of products) {
    const n = fold(p.name);
    if (n.startsWith(q)) starts.push(p);
    else if (n.includes(q)) contains.push(p);
  }
  return [...starts, ...contains].slice(0, limit);
}

/** A product still waiting for its purchase price — shown as "Prix à fixer". */
export function needsPurchasePrice(p: Pick<Product, 'cost_price'>): boolean {
  return !(p.cost_price > 0);
}

/** No sale price yet (stored as 0): the grid card shows "Prix à fixer", tappable to complete. */
export function needsSalePrice(p: Pick<Product, 'sale_price'>): boolean {
  return !(p.sale_price > 0);
}

/**
 * Anything worth keeping if the sheet is dismissed? Quantity alone never counts (it defaults to 1
 * and is sticky), so an untouched sheet leaves no draft.
 */
export function isBlankDraft(s: QuickAddState): boolean {
  return (
    !s.name.trim() && !s.price.trim() && !s.purchasePrice.trim() && !s.fees.trim() &&
    !s.supplierId && !s.variants.some(v => v.name.trim() || v.qty.trim() || v.touched)
  );
}

/** Next sheet state after a successful add: everything cleared EXCEPT the quantity (sticky). */
export function afterAdd(s: QuickAddState): QuickAddState {
  return { ...EMPTY_QUICK_ADD, qty: s.qty };
}

/** Edit mode: the sheet's starting state for a stored product (its stock is shown as a fact, not typed). */
export function editingToState(p: Product, variants: ProductVariant[], currency: string): QuickAddState {
  const money = (n: number) => (n > 0 ? formatAmountInput(String(Math.round(n)), currency) : '');
  return {
    name: p.name,
    price: money(p.sale_price),
    qty: String(Math.max(Math.round(p.stock_qty || 0), 0)),
    models: !!p.has_variants,
    variants: p.has_variants
      ? variants.map(v => ({
          key: v.id, name: v.name, qty: String(v.stock_qty), price: money(v.sale_price),
          touched: true, locked: true, cost: v.cost_price,
        }))
      : [],
    purchasePrice: money(p.cost_price),
    fees: '',
    supplierId: p.supplier_id ?? '',
  };
}
