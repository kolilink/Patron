// Pre-send receipt edit: fix a typo in a sale / credit that is still in the
// outbox, BEFORE it ever reaches the server and before the receipt is sent.
// Each function validates for humans (French, what to do), rewrites the queued
// payload in place through patchPendingOpPayload — same chokepoint as
// enqueue(), same idempotency key — and refreshes the pending overlay so the
// lists and totals reflect the correction at once. Offline-safe: no network.
//
// Scope, on purpose: pending items only. A synced quick sale / credit has no
// edit RPC and none is invented; a synced cart sale goes through edit_sale
// (Ventes detail), which needs a live clock.
import { patchPendingOpPayload } from '@/lib/db';
import { isOutboxValidationError } from '@/lib/outboxValidation';
import { useVentesStore } from '@/stores/ventes';

export type PendingEditResult = { ok: true } | { ok: false; error: string };

const ALREADY_SENT = "Déjà envoyé : cette opération ne peut plus être modifiée ici.";
const fail = (error: string): PendingEditResult => ({ ok: false, error });
const cents = (n: number) => Math.round(n * 100);

export interface QuickEdit { unitPrice: number; qty: number; label: string }
export interface CreditEdit { amount: number }
export interface SaleEdit { lines: { qty: number; unitPrice: number }[]; discount: number }

export function validateQuickEdit(e: QuickEdit): string | null {
  if (!(e.unitPrice > 0)) return 'Entrez un prix valide.';
  if (!Number.isInteger(e.qty) || e.qty < 1) return 'La quantité doit être d’au moins 1.';
  return null;
}

export function validateCreditEdit(e: CreditEdit): string | null {
  if (!(e.amount > 0)) return 'Entrez un montant valide.';
  return null;
}

export function validateSaleEdit(e: SaleEdit): string | null {
  if (e.lines.length === 0) return 'Il faut au moins un article.';
  for (const l of e.lines) {
    if (!Number.isInteger(l.qty) || l.qty < 1) return 'La quantité doit être d’au moins 1.';
    if (!(l.unitPrice >= 0)) return 'Entrez un prix valide.';
  }
  if (!(e.discount >= 0)) return 'Entrez une réduction valide.';
  const subtotal = e.lines.reduce((t, l) => t + l.qty * l.unitPrice, 0);
  if (e.discount > subtotal) return 'La réduction dépasse le total.';
  return null;
}

async function patch(
  operation: string,
  key: string,
  mutate: (p: Record<string, unknown>) => Record<string, unknown>,
): Promise<PendingEditResult> {
  try {
    const found = await patchPendingOpPayload(operation, key, mutate);
    if (!found) return fail(ALREADY_SENT);
  } catch (err) {
    // The chokepoint refused the corrected payload: nothing was written.
    if (isOutboxValidationError(err)) return fail(err.userMessage);
    return fail("Impossible d'enregistrer la modification sur cet appareil. Réessayez.");
  }
  try {
    await useVentesStore.getState().refreshPendingOverlay();
  } catch {
    // The correction is durable; the lists just catch up at the next refresh.
  }
  return { ok: true };
}

export async function editPendingQuickSale(key: string, e: QuickEdit): Promise<PendingEditResult> {
  const problem = validateQuickEdit(e);
  if (problem) return fail(problem);
  return patch('submit_quick_sale', key, p => ({
    ...p,
    p_unit_price: cents(e.unitPrice),
    p_qty: e.qty,
    p_label: e.label.trim() || null,
  }));
}

export async function editPendingCarnetDebt(key: string, e: CreditEdit): Promise<PendingEditResult> {
  const problem = validateCreditEdit(e);
  if (problem) return fail(problem);
  return patch('submit_carnet_debt', key, p => ({ ...p, p_amount: cents(e.amount) }));
}

/** `e.lines` is positional: line i patches p_cart[i] (the receipt lists the cart in order). */
export async function editPendingSale(key: string, e: SaleEdit): Promise<PendingEditResult> {
  const problem = validateSaleEdit(e);
  if (problem) return fail(problem);
  return patch('submit_sale', key, p => {
    const cart = ((p.p_cart as Record<string, unknown>[] | undefined) ?? []).map((line, i) => ({
      ...line,
      qty: e.lines[i]?.qty ?? line.qty,
      unit_price: e.lines[i] ? cents(e.lines[i].unitPrice) : line.unit_price,
    }));
    const total = cart.reduce((t, l) => t + (l.qty as number) * (l.unit_price as number), 0);
    const discount = cents(e.discount);
    const net = Math.max(0, total - discount);
    const next: Record<string, unknown> = { ...p, p_cart: cart, p_total_amount: total, p_discount_amount: discount };
    if (p.p_pay_amount != null) {
      // Paid in full stays paid in full at the corrected price; a partial
      // payment never exceeds what is now owed.
      next.p_pay_amount = p.p_is_credit ? Math.min(p.p_pay_amount as number, net) : net;
    }
    return next;
  });
}
