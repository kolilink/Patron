// Sale-receipt content (variants A lined / B quick sale / C credit). Pure, like
// debtReceipt.ts: every string — and every robustness rule — is unit-tested
// without rendering, and the view (DebtReminderReceipt.tsx) never formats a
// number. Inputs are DISPLAY units (not cents); callers divide by 100.
import { formatAmount } from '@/src/utils/format';
import { formatDate } from '@/src/utils/dates';
import { firstName } from '@/src/utils/debtReceipt';
import type { DebtReceiptContent, ReceiptLineContent } from '@/src/utils/debtReceipt';

interface ReceiptSourceBase {
  businessName: string;
  currency: string;
  date: Date;
  /** Idempotency key of the still-queued op (== the pending sale's id). Null once synced / unknown. */
  key: string | null;
  /** True while the op is still in the outbox — the only state the pre-send edit applies to. */
  pending: boolean;
}

/** Variant B — quick sale: unit price × qty, optional label, paid in full by construction. */
export interface QuickReceiptSource extends ReceiptSourceBase {
  kind: 'quick';
  unitPrice: number;
  qty: number;
  label: string | null;
  methodLabel?: string;
}

/** Variant C — quick credit / carnet entry: client + amount, nothing else. */
export interface CreditReceiptSource extends ReceiptSourceBase {
  kind: 'credit';
  clientName: string;
  amount: number;
}

export interface SaleReceiptLineInput { name: string; qty: number; unitPrice: number }

/** Variant A — a cart sale. `paid` is what was received at sale time. */
export interface SaleReceiptSource extends ReceiptSourceBase {
  kind: 'sale';
  lines: SaleReceiptLineInput[];
  discount: number;
  paid: number;
  method: string | null;
  isCredit: boolean;
  clientName: string | null;
}

export type ReceiptSource = QuickReceiptSource | CreditReceiptSource | SaleReceiptSource;

/** Rows that fit the 4:5 card; the rest collapse into one "+ N autres articles" row. */
export const MAX_RECEIPT_LINES = 5;

const FOOTER = 'Généré par Patron';

/** payments_method_check values (v7) → the label printed on the receipt. */
export function paymentMethodLabel(method: string | null | undefined): string | undefined {
  switch (method) {
    case 'especes': return 'Espèces';
    case 'orange': case 'mtn': case 'moov': case 'digital': case 'mobile_money': return 'Mobile Money';
    case 'carte': return 'Carte';
    case 'virement': return 'Virement';
    default: return undefined;
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function dayLabel(d: Date): string {
  return formatDate(d, 'short');
}

function timeLabel(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function base(src: ReceiptSource): Pick<DebtReceiptContent, 'businessName' | 'greeting' | 'context' | 'remainingLine' | 'demande' | 'close' | 'footer'> {
  return {
    businessName: src.businessName.trim(),
    greeting: '', context: [], remainingLine: '', demande: '',
    close: 'Merci.',
    footer: FOOTER,
  };
}

function buildQuick(src: QuickReceiptSource): DebtReceiptContent {
  const label = src.label?.trim() || '';
  let labelRow: string | undefined;
  if (label) labelRow = src.qty > 1 ? `${label} × ${src.qty}` : label;
  else if (src.qty > 1) labelRow = `Quantité : ${src.qty}`;
  const method = src.methodLabel ?? 'Espèces';
  return {
    ...base(src),
    variant: 'quick',
    contextLine: `Vente · ${dayLabel(src.date)}`,
    label: labelRow,
    hero: formatAmount(src.unitPrice * src.qty, src.currency),
    payment: { kind: 'paid', methodLabel: method },
  };
}

function buildCredit(src: CreditReceiptSource): DebtReceiptContent {
  const first = firstName(src.clientName);
  return {
    ...base(src),
    variant: 'credit',
    greeting: first ? `Bonjour ${first},` : 'Bonjour,',
    contextLine: `Crédit du ${dayLabel(src.date)}`,
    hero: `Crédit : ${formatAmount(src.amount, src.currency)}`,
    payment: { kind: 'credit' },
    clientName: src.clientName,
  };
}

function buildLined(src: SaleReceiptSource): DebtReceiptContent {
  const cur = src.currency;
  const all: ReceiptLineContent[] = src.lines.map(l => ({
    name: l.name,
    qty: l.qty,
    unitPrice: formatAmount(l.unitPrice, cur),
    lineTotal: formatAmount(l.unitPrice * l.qty, cur),
  }));
  const shown = all.length > MAX_RECEIPT_LINES ? all.slice(0, MAX_RECEIPT_LINES - 1) : all;
  const hidden = all.length - shown.length;
  const subtotal = src.lines.reduce((t, l) => t + l.unitPrice * l.qty, 0);
  const discount = Math.max(0, src.discount);
  const net = Math.max(0, subtotal - discount);
  const remaining = Math.max(0, net - src.paid);
  const credit = src.isCredit || remaining > 0.01;
  const first = firstName(src.clientName ?? '');

  return {
    ...base(src),
    variant: 'lined',
    contextLine: `Reçu · ${dayLabel(src.date)}, ${timeLabel(src.date)}`,
    lines: shown,
    moreLines: hidden > 0 ? `+ ${hidden} autre${hidden > 1 ? 's' : ''} article${hidden > 1 ? 's' : ''}` : undefined,
    totals: {
      subtotal: formatAmount(subtotal, cur),
      discount: discount > 0 ? `−${formatAmount(discount, cur)}` : undefined,
      net: formatAmount(net, cur),
    },
    payment: credit
      ? {
        kind: 'credit',
        received: src.paid > 0.01 ? formatAmount(src.paid, cur) : undefined,
        remaining: formatAmount(remaining > 0.01 ? remaining : net, cur),
      }
      : { kind: 'paid', methodLabel: paymentMethodLabel(src.method) },
    clientName: credit && first ? first : undefined,
  };
}

export function buildReceiptContent(src: ReceiptSource): DebtReceiptContent {
  switch (src.kind) {
    case 'quick': return buildQuick(src);
    case 'credit': return buildCredit(src);
    case 'sale': return buildLined(src);
  }
}

// ── From a just-submitted capture (zero fetch) ──────────────────────────────
// The store hands back exactly what it queued; the receipt is built from those
// values, so the "Reçu" link works with no network and no lookup.

export function quickReceiptFromSubmit(
  r: { idempotencyKey: string; unitPriceCents: number; qty: number; label: string | null },
  biz: { businessName: string; currency: string },
  date: Date = new Date(),
): QuickReceiptSource {
  return {
    kind: 'quick', ...biz, date, key: r.idempotencyKey, pending: true,
    unitPrice: r.unitPriceCents / 100, qty: r.qty, label: r.label,
  };
}

export function creditReceiptFromSubmit(
  r: { idempotencyKey: string; customerName: string; amountCents: number },
  biz: { businessName: string; currency: string },
  date: Date = new Date(),
): CreditReceiptSource {
  return {
    kind: 'credit', ...biz, date, key: r.idempotencyKey, pending: true,
    clientName: r.customerName, amount: r.amountCents / 100,
  };
}

// ── From a Ventes-history row (synced OR still-pending) ─────────────────────

/** The slice of a Vente (stores/ventes.ts) the receipt needs. */
export interface ReceiptVente {
  id: string;
  total_amount: number;
  discount_amount?: number | null;
  amount_paid?: number | null;
  status: string;
  is_credit?: boolean;
  customer_name?: string | null;
  created_at: string;
  _pending?: boolean;
  lines?: { product_id?: string; product_name: string; variant_name?: string | null; qty: number; unit_price: number }[];
  payments?: { method: string; amount: number }[];
}

/**
 * Builds the receipt source for any Ventes row, from local data only — never
 * silent: a sale whose lines aren't known (a synced row never opened online)
 * still gets a truthful amount-only receipt instead of no receipt at all.
 */
export function receiptSourceFromVente(
  sale: ReceiptVente,
  biz: { businessName: string; currency: string },
): ReceiptSource {
  const date = new Date(sale.created_at);
  const common = { ...biz, date, key: sale._pending ? sale.id : null, pending: !!sale._pending };
  const discount = sale.discount_amount ?? 0;
  const net = Math.max(0, sale.total_amount - discount);
  const credit = sale.is_credit || sale.status === 'credit';
  const lines = sale.lines ?? [];

  if (lines.length === 0) {
    // Amount-only: a carnet entry, or a sale whose lines aren't cached.
    if (credit) {
      return { kind: 'credit', ...common, clientName: sale.customer_name ?? '', amount: net };
    }
    return { kind: 'quick', ...common, unitPrice: net, qty: 1, label: null, methodLabel: paymentMethodLabel(sale.payments?.[0]?.method) };
  }

  const only = lines[0];
  if (lines.length === 1 && !credit && discount === 0 && !sale.customer_name && (only.product_id === '' || only.product_name === 'Vente rapide')) {
    return {
      kind: 'quick', ...common,
      unitPrice: only.unit_price, qty: only.qty,
      label: only.product_name === 'Vente rapide' ? null : only.product_name,
      methodLabel: paymentMethodLabel(sale.payments?.[0]?.method),
    };
  }

  return {
    kind: 'sale', ...common,
    lines: lines.map(l => ({
      name: l.variant_name ? `${l.product_name} · ${l.variant_name}` : l.product_name,
      qty: l.qty, unitPrice: l.unit_price,
    })),
    discount,
    // A closed (paye) sale is fully paid by definition — fetchSales leaves amount_paid
    // undefined for a plain cash sale, which must not read as "nothing received".
    paid: credit ? (sale.amount_paid ?? sale.payments?.reduce((t, p) => t + p.amount, 0) ?? 0) : net,
    method: sale.payments?.[0]?.method ?? null,
    isCredit: !!credit,
    clientName: sale.customer_name ?? null,
  };
}

// ── Fit ─────────────────────────────────────────────────────────────────────
// The card is a fixed 360×450 design sheet. Variant A's height depends on the
// sale (rows, a discount, a credit block), so the body is laid out at a uniform
// scale chosen so the worst case still fits — shrink, never clip or truncate.
// Heights are in design units and mirror the type tokens in the view.
const BODY_AVAILABLE = 348; // 450 − header (34+19) − footer (26+15) − breathing room

export function linedBodyHeight(c: DebtReceiptContent): number {
  const row = 17 * 1.35;
  let h = 10 + 15 * 1.35; // context
  const rows = (c.lines?.length ?? 0) + (c.moreLines ? 1 : 0);
  if (rows > 0) h += 20 + rows * (row + 10) + 33; // lines block + divider
  if (c.totals) {
    if (c.totals.discount) h += 2 * (row + 6);
    h += 8 + 20 * 1.35; // Net à payer
  }
  if (c.payment?.kind === 'credit') {
    h += 20 + 20 * 1.35 + (c.payment.received ? row : 0) + 24 * 1.3 + (c.clientName ? row : 0);
  } else if (c.payment) {
    h += 20 + 20 * 1.35;
  }
  return h + 16 + row; // Merci.
}

/** 1 when the body fits at design size, otherwise the factor that makes it fit. */
export function linedBodyScale(c: DebtReceiptContent): number {
  return Math.min(1, BODY_AVAILABLE / linedBodyHeight(c));
}
