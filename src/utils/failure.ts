// ONE failure vocabulary. Every failure the vendor sees is built here, so it
// speaks the same honest language (what happened, why ONLY if it helps her
// act, exactly one action) — the way formatAmount is the choke point for money.
//
// Rules (enforced by __tests__/failure-vocabulary.test.ts):
//  - `what`: a concrete, active sentence in French, short ("Le paiement n'a pas
//    été enregistré."). Never "Erreur", never "échoué", never a code, never blame.
//  - `why`: optional, only when it helps her act ("Pas de connexion.").
//    Never err.message, never an SQLSTATE or HTTP code.
//  - `action`: exactly one ("Réessayer", "Retour", or the single next step).
//  - `supportDetail`: short reference for the founder when she writes in; shown
//    small, never as the message.
//  - Static text. No animation on an error.

import { extractRawMessage, friendlyMessage } from '@/lib/errors';
import { isNetworkError } from '@/lib/networkError';
import { FAILURE_COPY, type FailureKey } from './failureCopy';

export interface FailureAction {
  label: string;
  onPress: () => void;
}

export interface FailureShape {
  what: string;
  why?: string;
  action: FailureAction;
  supportDetail?: string;
}

/** Internal, machine-readable failure kinds. Control flow branches on these — never on human copy. */
export type FailureCode = 'network' | 'invalid' | 'rejected' | 'unknown';

export function classifyFailure(err: unknown): FailureCode {
  if (isNetworkError(err)) return 'network';
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'P0001') return 'rejected';
  if (err == null) return 'unknown';
  return 'unknown';
}

/**
 * A sentence the SERVER authored on purpose (RAISE EXCEPTION, SQLSTATE P0001):
 * already French, already non-technical, meant to reach her verbatim. The only
 * sanctioned way to show a server message — never read `.message` directly.
 */
export function serverSentence(err: unknown): string | undefined {
  const e = err as { code?: unknown; message?: unknown } | null;
  return e && e.code === 'P0001' && typeof e.message === 'string' && e.message.trim() ? e.message.trim() : undefined;
}

export const NO_CONNECTION_WHY = 'Pas de connexion.';

/**
 * The one reason worth telling her, or undefined. A lost connection is told
 * plainly; a server sentence we authored in French (RAISE EXCEPTION) passes
 * through verbatim; anything else (English, codes, stack text) is dropped —
 * a reason she cannot act on is noise.
 */
export function failureReason(input: unknown): string | undefined {
  // Stores keep their last error as a string; treat it like an error with that message.
  const err = typeof input === 'string' ? { message: input } : input;
  if (isNetworkError(err)) return NO_CONNECTION_WHY;
  const authored = serverSentence(err);
  if (authored) return authored;
  const raw = extractRawMessage(err);
  if (!raw) return undefined;
  const friendly = friendlyMessage(err, '');
  // friendlyMessage returns either the server's own French sentence, a table
  // translation, or the '' fallback. Table translations that still say "Erreur"
  // are not acceptable here.
  if (!friendly || /\berreur\b/i.test(friendly)) return undefined;
  return friendly;
}

/** One line for a toast: the registered sentence, plus the reason when there is one. */
export function failureLine(key: FailureKey, err?: unknown): string {
  const copy = FAILURE_COPY[key] as { what: string; why?: string };
  const why = (err !== undefined ? failureReason(err) : undefined) ?? copy.why;
  return why ? `${copy.what} ${why}` : copy.what;
}

export function buildFailure(opts: {
  what: string;
  why?: string;
  err?: unknown;
  action: FailureAction;
  supportDetail?: string;
}): FailureShape {
  const why = opts.why ?? (opts.err !== undefined ? failureReason(opts.err) : undefined);
  return { what: opts.what, ...(why ? { why } : {}), action: opts.action, ...(opts.supportDetail ? { supportDetail: opts.supportDetail } : {}) };
}

const BANNED: { name: string; re: RegExp }[] = [
  { name: '"Erreur" / error word', re: /\b(erreur|error|exception|undefined|null|NaN)\b/i },
  { name: '"échoué"-style wording', re: /(^|[^a-zà-ÿ])([ée]chou[ée]?s?|[ée]chec)(?![a-zà-ÿ])/i },
  { name: 'raw code (SQLSTATE / HTTP / 5-char code)', re: /\b(P0001|42\d{3}|23\d{3}|XX000|[45]\d{2})\b/ },
  { name: 'blame', re: /\b(votre faute|vous avez mal|vous auriez dû|à cause de vous)\b/i },
  { name: 'alarm words', re: /\b(critique|urgent|danger(eux)?|alerte|grave|catastrophe|perdu(e|s)?)\b/i },
];

/** Returns the vocabulary violations of a failure sentence (empty = fine). */
export function sentenceProblems(text: string): string[] {
  const problems = BANNED.filter(b => b.re.test(text)).map(b => `banned: ${b.name}`);
  if (text.length > 90) problems.push('too long (French is her second language: keep it short)');
  return problems;
}

export function vocabularyProblems(shape: Pick<FailureShape, 'what' | 'why'> & { action?: FailureAction }): string[] {
  const problems: string[] = [];
  if (!shape.what.trim()) problems.push('what is empty');
  if (!/[.!]$/.test(shape.what.trim())) problems.push('what must be a full sentence ending with a period');
  problems.push(...sentenceProblems(shape.what).map(p => `what: ${p}`));
  if (shape.why) problems.push(...sentenceProblems(shape.why).map(p => `why: ${p}`));
  if (shape.action && !shape.action.label.trim()) problems.push('action label is empty');
  return problems;
}
