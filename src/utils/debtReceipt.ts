// Content for the WhatsApp debt-reminder receipt image. Pure and dependency-light
// so every string (and every robustness rule) is unit-tested without rendering.
// The view (src/components/DebtReminderReceipt.tsx) only lays this out — it
// never invents or reformats a value.
import { formatAmount } from '@/src/utils/format';
import { formatDate, toDate } from '@/src/utils/dates';
import { debtAgeTier } from '@/src/utils/clientReminder';

export type ReminderTone = 'doux' | 'ferme';

/** 'urgent' (>= 30 days) → Ferme, otherwise Doux. She can override in the preview. */
export function defaultReminderTone(daysOldestDebt: number): ReminderTone {
  return debtAgeTier(daysOldestDebt) === 'urgent' ? 'ferme' : 'doux';
}

export interface DebtReceiptDebt {
  /** Real product label(s) of the credit sale; null/'' for a bare carnet debt. */
  label: string | null;
  /** ISO date (YYYY-MM-DD or full timestamp) the credit was written. */
  date: string;
}

export interface DebtReceiptInput {
  businessName: string;
  clientName: string;
  currency: string;
  /** The exact remaining balance (already clamped >= 0 by the caller). */
  totalOwed: number;
  /** Open credit lines, newest first. */
  debts: DebtReceiptDebt[];
  lastPayment: { amount: number; date: string } | null;
  now?: Date;
}

export interface DebtReceiptContent {
  businessName: string;
  greeting: string;
  context: string;
  articleLines: string[];
  lastPaymentLine: string | null;
  /** "Il reste : 25 000 GNF" — the full, exact amount, never summarized. */
  remainingLine: string;
  demande: string[];
  trust: string;
  close: string;
  footer: string;
}

export const MAX_ARTICLE_LINES = 3;

/**
 * Deterministic pre-scale (1 = full size) so a long value fits BEFORE the
 * native `adjustsFontSizeToFit` runs — that prop is the second layer, not the
 * only one, because it behaves differently on Android inside a flex row. A
 * value is never cut: it only gets smaller. `fitChars` = how many characters
 * fit at full size; `byLongestWord` measures the longest unbreakable word
 * (for text that may wrap, like the greeting).
 */
export function fitScale(text: string, fitChars: number, byLongestWord = false): number {
  const len = byLongestWord
    ? Math.max(1, ...text.split(/\s+/).map(w => w.length))
    : Math.max(1, text.length);
  return Math.min(1, fitChars / len);
}
// Measured against the 360-unit design sheet at the 36-unit display size.
export const REMAINING_FIT_CHARS = 24;
export const GREETING_FIT_CHARS = 16;
const MAX_LABEL_CHARS = 70;

const COPY: Record<ReminderTone, { context: string; demande: string[]; close: string }> = {
  doux: {
    context: 'Je fais le point sur mon carnet :',
    demande: ['Quand vous pouvez, même petit à petit.'],
    close: 'Merci !',
  },
  ferme: {
    context: 'Je reviens vers vous pour ce solde :',
    demande: [
      "J'ai besoin qu'on le règle ensemble cette semaine — dites-moi ce qui est possible pour vous.",
      "Même une partie m'aide beaucoup.",
    ],
    close: 'Merci.',
  },
};

/** First word of the name, used for the greeting ("Mariam Diallo" → "Mariam"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

function shortDate(iso: string, now: Date): string {
  const d = toDate(iso);
  return formatDate(d, d.getFullYear() === now.getFullYear() ? 'dayMonth' : 'short');
}

// "2 oct." already ends with its abbreviation dot; "2 oct. 2025" does not.
function endSentence(t: string): string {
  return t.endsWith('.') ? t : `${t}.`;
}

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function articleLines(debts: DebtReceiptDebt[], now: Date): string[] {
  const lines = debts.slice(0, MAX_ARTICLE_LINES).map(d => {
    const date = shortDate(d.date, now);
    const label = d.label?.trim();
    return label ? `${clip(label, MAX_LABEL_CHARS)} — le ${date}` : `Carnet du ${date}`;
  });
  const hidden = debts.length - MAX_ARTICLE_LINES;
  if (hidden > 0) lines.push(hidden === 1 ? '+ 1 autre article' : `+ ${hidden} autres articles`);
  return lines;
}

export function buildDebtReceiptContent(input: DebtReceiptInput, tone: ReminderTone): DebtReceiptContent {
  const now = input.now ?? new Date();
  const copy = COPY[tone];
  const first = firstName(input.clientName);
  return {
    businessName: input.businessName.trim(),
    greeting: first ? `Bonjour ${first},` : 'Bonjour,',
    context: copy.context,
    articleLines: articleLines(input.debts, now),
    lastPaymentLine: input.lastPayment
      ? endSentence(`Dernier paiement reçu : ${formatAmount(input.lastPayment.amount, input.currency)} le ${shortDate(input.lastPayment.date, now)}`)
      : null,
    remainingLine: `Il reste : ${formatAmount(input.totalOwed, input.currency)}`,
    demande: copy.demande,
    trust: 'Je sais que vous êtes une personne de parole.',
    close: copy.close,
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
