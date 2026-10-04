// Pure copy-builder for the client-ledger payment overlay (clients/[name].tsx).
// Kept separate from the component so the honesty rule is unit-testable
// without rendering React or touching Zustand.
//
// Rule (the fix for the "C'est réglé !" lie): the overlay may only declare a
// debt settled when the remaining balance is EXACTLY 0 after the payment.
// - remaining === 0  -> "C'est réglé !" (now actually true)
// - remaining >  0   -> "Bien reçu !" + a plain "Reste : …" line. This
//   celebrates the money that was actually received, never the debt being
//   done — a 20 000 payment against 100 000 owed shows "Reste : 80 000",
//   not a settlement celebration.

import { formatAmount } from './format';

export interface PaymentOverlayCopy {
    headline: string;
    // Plain "Reste : 80 000 USD" line, or null when fully settled.
    reste: string | null;
}

export function paymentOverlayCopy(remaining: number, currency: string): PaymentOverlayCopy {
    // Sub-cent float remainder is treated as settled, matching
    // repaymentConfirmation's own rounding-safety threshold — so a multi-entry
    // ledger that nets to a 0.001-unit hair still reads as settled, not "owes".
    if (remaining <= 0.005) {
        return { headline: "C'est réglé !", reste: null };
    }
    return { headline: 'Bien reçu !', reste: `Reste : ${formatAmount(remaining, currency)}` };
}
