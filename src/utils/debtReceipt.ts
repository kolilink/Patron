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
