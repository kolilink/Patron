// The one definition of "a debt entry that can be saved", shared by the
// button's `disabled`, the handler's guard and (by construction) the outbox
// contract in lib/outboxValidation.ts: a debt needs a debtor and a positive
// amount. Because the button and the handler read this same function, the
// button can never be enabled for something the handler (or the validator)
// would then refuse.
import { amountInputToCents } from '@/src/utils/format';

export interface DebtEntry { name: string; amountCents: number }

export function readyDebtEntry(name: string, amountText: string, currency: string): DebtEntry | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  const amountCents = amountInputToCents(amountText, currency);
  if (amountCents === null || amountCents <= 0) return null;
  return { name: trimmed, amountCents };
}

// "I don't know their name": a real, distinct label per unknown person.
// One shared bucket would merge different people's debts into one ledger (a
// payment by one would settle another's, FIFO by name); numbering keeps each
// unknown debtor separate and truthful, and the vendor can still rename later.
export const WALK_IN_LABEL = 'Client de passage';

export function nextWalkInLabel(existingNames: readonly string[]): string {
  const re = new RegExp(`^${WALK_IN_LABEL}(?: (\\d+))?$`, 'i');
  let max = 0;
  for (const n of existingNames) {
    const m = re.exec(n.trim());
    if (m) max = Math.max(max, m[1] ? parseInt(m[1], 10) : 1);
  }
  return max === 0 ? WALK_IN_LABEL : `${WALK_IN_LABEL} ${max + 1}`;
}
