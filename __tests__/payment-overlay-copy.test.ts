import { paymentOverlayCopy } from '@/src/utils/paymentOverlayCopy';

// The honesty rule behind the "C'est réglé !" fix: the settlement headline is
// only ever produced when the remaining balance is exactly 0 after a payment.
// A partial payment celebrates the money received ("Bien reçu !") and states
// the plain remaining amount, never the debt being done.
//
// formatAmount groups thousands with a non-breaking space (U+00A0), same as
// saveConfirmationCopy — so expected strings below use that exact character.

const NBSP = '\u00A0';

describe('paymentOverlayCopy', () => {
    test('partial payment (20 000 of 100 000 owed -> 80 000 remaining): "Bien reçu !" + plain "Reste" line, never settled', () => {
        const copy = paymentOverlayCopy(80000, 'USD');
        expect(copy.headline).toBe('Bien reçu !');
        expect(copy.reste).toBe(`Reste : 80${NBSP}000 USD`);
    });

    test('full payment (remaining exactly 0): "C\'est réglé !" with no Reste line', () => {
        const copy = paymentOverlayCopy(0, 'USD');
        expect(copy.headline).toBe("C'est réglé !");
        expect(copy.reste).toBeNull();
    });

    test('multi-entry ledger settling to exactly 0: settled headline', () => {
        const copy = paymentOverlayCopy(0, 'GNF');
        expect(copy.headline).toBe("C'est réglé !");
        expect(copy.reste).toBeNull();
    });

    test('multi-entry ledger with 1 left over: partial headline, "Reste : 1"', () => {
        const copy = paymentOverlayCopy(1, 'GNF');
        expect(copy.headline).toBe('Bien reçu !');
        expect(copy.reste).toBe('Reste : 1 GNF');
    });

    test('a sub-cent float remainder is treated as settled (rounding safety)', () => {
        const copy = paymentOverlayCopy(0.001, 'USD');
        expect(copy.headline).toBe("C'est réglé !");
        expect(copy.reste).toBeNull();
    });

    test('currency is not hardcoded — a decimal currency shows 2 decimals in the Reste line', () => {
        const decimal = paymentOverlayCopy(15.5, 'USD');
        expect(decimal.reste).toBe('Reste : 15.50 USD');
    });
});
