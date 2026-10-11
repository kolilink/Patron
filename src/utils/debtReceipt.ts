// Content for the WhatsApp debt-reminder receipt image. Pure and dependency-light
// so every string (and every robustness rule) is unit-tested without rendering.
// The view (src/components/DebtReminderReceipt.tsx) only lays this out — it
// never invents or reformats a value.
import { formatAmount } from '@/src/utils/format';
import { formatDate } from '@/src/utils/dates';

// Portrait 4:5 card, exported at 1080×1350. Shared by the view, the capture
// helper and the tests (kept here so none of them needs to import a component).
export const RECEIPT_ASPECT = 4 / 5;
export const RECEIPT_EXPORT_WIDTH = 1080;
export const RECEIPT_EXPORT_HEIGHT = 1350;

export interface DebtReceiptInput {
  businessName: string;
  clientName: string;
  currency: string;
  /** The exact remaining balance (already clamped >= 0 by the caller). */
  totalOwed: number;
  now?: Date;
}

/** One row of a lined sale receipt. Money fields are finished strings; qty is a plain count. */
export interface ReceiptLineContent {
  name: string;
  qty: number;
  unitPrice: string;
  lineTotal: string;
}

export interface ReceiptTotalsContent {
  /** Finished strings. `discount` is only set when a reduction exists. */
  subtotal: string;
  discount?: string;
  net: string;
}

export interface ReceiptPaymentContent {
  kind: 'paid' | 'credit';
  /** "Espèces" — paid sales only. */
  methodLabel?: string;
  /** Credit with an upfront amount: "Reçu : 5 000 USD". */
  received?: string;
  /** Credit: "Reste : 20 000 USD". */
  remaining?: string;
}

export interface DebtReceiptContent {
  businessName: string;
  greeting: string;
  context: string[];
  /** "Il reste : 2 450 000 GNF" — fmt()'s finished string; the view never formats. */
  remainingLine: string;
  demande: string;
  close: string;
  footer: string;
  /**
   * Absent = the original debt-reminder layout, rendered byte-identically.
   * 'lined' | 'quick' | 'credit' = the sale-receipt variants (A / B / C), which
   * read the optional fields below instead of greeting/remainingLine/demande.
   */
  variant?: 'lined' | 'quick' | 'credit';
  /** Variant B/C: the single context line under the business name. */
  contextLine?: string;
  /** Variant B: what was sold ("Riz, sac de 5kg × 2"). Absent = no row, no gap. */
  label?: string;
  /** Variant B/C: the hero amount ("12 000 USD" / "Crédit : 25 000 USD"). */
  hero?: string;
  /** Variant A. */
  lines?: ReceiptLineContent[];
  /** Variant A: "+ 3 autres articles" when the sale has more rows than fit the card. */
  moreLines?: string;
  totals?: ReceiptTotalsContent;
  payment?: ReceiptPaymentContent;
  /** Variant A credit: "Pour Aïcha". */
  clientName?: string;
}

/** First word of the name, used for the greeting ("Mariam Diallo" → "Mariam"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

// "7 oct." already ends with its abbreviation dot; "7 mai" does not.
function endSentence(t: string): string {
  return t.endsWith('.') ? t : `${t}.`;
}

export function buildDebtReceiptContent(input: DebtReceiptInput): DebtReceiptContent {
  const now = input.now ?? new Date();
  const first = firstName(input.clientName);
  return {
    businessName: input.businessName.trim(),
    greeting: first ? `Bonjour ${first},` : 'Bonjour,',
    context: ['Petit rappel sur votre crédit', `Solde du ${endSentence(formatDate(now, 'dayMonth'))}`],
    remainingLine: `Il reste : ${formatAmount(input.totalOwed, input.currency)}`,
    demande: 'Quand vous pouvez, même petit à petit.',
    close: 'Merci.',
    footer: 'Généré par Patron',
  };
}

export interface LedgerPaymentRow { order_id: string; amount: number; date: string; created_at: string }

/**
 * The most recent payment actually received against the given debt's sales.
 * A reversed payment stays in the ledger as the original (+) plus a
 * compensating (−) row, so each negative cancels one equal positive on the
 * same sale; what remains is real money received. A payment split across
 * several sales (FIFO) yields rows sharing one created_at — they are summed.
 */
export function lastPaymentFor(rows: LedgerPaymentRow[], saleIds: Set<string>): { amount: number; date: string } | null {
  const mine = rows.filter(r => saleIds.has(r.order_id));
  const positives = mine.filter(r => r.amount > 0).sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const neg of mine.filter(r => r.amount < 0).sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    // Cancel the latest equal positive that existed before the reversal.
    let at = -1;
    positives.forEach((p, i) => { if (p.order_id === neg.order_id && p.amount === -neg.amount && p.created_at <= neg.created_at) at = i; });
    if (at >= 0) positives.splice(at, 1);
  }
  const newest = [...positives].sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at))[0];
  if (!newest) return null;
  const amount = positives
    .filter(p => p.created_at === newest.created_at && p.date === newest.date)
    .reduce((t, p) => t + p.amount, 0);
  return { amount, date: newest.date };
}
