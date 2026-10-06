// Pure copy-builders for the post-save confirmation banner (SaveConfirmation.tsx).
// Kept separate from the component/store so the exact strings are unit-testable
// without rendering React or touching Zustand.
//
// Two psych rules apply to every string here: (1) name the checkable result
// (who, what, how much — never a bare event label like "Enregistré"), and
// (2) plain, concrete French, 100% "vous", neutral tone, no exclamation hype.

import { formatAmount } from './format';

// NOTE: every amount param below is a display-unit number (the same shape
// already held in Zustand store state — e.g. `sale.total_amount`), never
// BIGINT cents. Stores divide by 100 on read from the DB (see CLAUDE.md's
// "Monetary amounts" section); these builders just forward to formatAmount().

export function creditSaleConfirmation(clientName: string, amount: number, currency: string): string {
  return `Enregistré — ${clientName} vous doit ${formatAmount(amount, currency)}.`;
}

// reste is the remaining balance AFTER the payment was applied.
// reste === 0 gets the distinct "Réglé" framing per spec (tone: 'settled').
export function repaymentConfirmation(
  clientName: string,
  reste: number,
  currency: string,
): { text: string; settled: boolean } {
  if (reste <= 0.005) {
    return { text: 'Réglé ✓', settled: true };
  }
  return { text: `Enregistré — ${clientName} vous doit ${formatAmount(reste, currency)}.`, settled: false };
}

export function cashSaleConfirmation(amount: number, currency: string): string {
  return `Enregistré — vente de ${formatAmount(amount, currency)}.`;
}

// ── Deletes: undo where it exists, otherwise a message naming exactly what went ──
export function archivedConfirmation(productName: string): string {
  return `${productName} désactivé.`;
}

export function saleCancelledConfirmation(amount: number, currency: string, customer?: string | null): string {
  const amt = formatAmount(amount, currency);
  return customer ? `Vente annulée : ${customer}, ${amt}.` : `Vente annulée : ${amt}.`;
}

export function supplierDeletedConfirmation(name: string): string {
  return `Fournisseur supprimé : ${name}.`;
}

export function memberRemovedConfirmation(name: string): string {
  return `${name} retiré de l'équipe.`;
}

export function inviteCodeRevokedConfirmation(): string {
  return "Code d'invitation révoqué.";
}

export function stakeRemovedConfirmation(productName: string, memberName: string): string {
  return `${productName} retiré pour ${memberName}.`;
}

export function partnerRemovedConfirmation(name: string): string {
  return `Partenaire retiré : ${name}.`;
}

export function productConfirmation(productName: string): string {
  return `Enregistré — ${productName} ajouté.`;
}

export interface DeliveryItem {
  qty: number;
  productName: string;
}

// Single item: "Enregistrée — 12 Riz, 60 000 GNF payés."
// Multi item:  "Enregistrée — 3 articles, 60 000 GNF payés."
export function deliveryConfirmation(items: DeliveryItem[], amountPaid: number, currency: string): string {
  const amount = formatAmount(amountPaid, currency);
  if (items.length === 1) {
    return `Enregistrée — ${items[0].qty} ${items[0].productName}, ${amount} payés.`;
  }
  return `Enregistrée — ${items.length} articles, ${amount} payés.`;
}
