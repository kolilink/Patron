import {
  creditSaleConfirmation,
  repaymentConfirmation,
  cashSaleConfirmation,
  productConfirmation,
  deliveryConfirmation,
} from '@/src/utils/saveConfirmationCopy';

describe('saveConfirmationCopy', () => {
  test('credit sale names the client and the debt', () => {
    expect(creditSaleConfirmation('Awa', 15000, 'GNF')).toBe('Enregistré — Awa vous doit 15 000 GNF.');
  });

  test('repayment with remaining balance names the client and what they still owe', () => {
    const { text, settled } = repaymentConfirmation('Awa', 5000, 'GNF');
    expect(text).toBe('Enregistré — Awa vous doit 5 000 GNF.');
    expect(settled).toBe(false);
  });

  test('repayment that fully settles the debt uses the distinct "Réglé" framing', () => {
    const { text, settled } = repaymentConfirmation('Awa', 0, 'GNF');
    expect(text).toBe('Réglé ✓');
    expect(settled).toBe(true);
  });

  test('repayment treats a sub-cent float remainder as settled (rounding safety)', () => {
    const { text, settled } = repaymentConfirmation('Awa', 0.001, 'GNF');
    expect(text).toBe('Réglé ✓');
    expect(settled).toBe(true);
  });

  test('cash sale states only the amount, no bare event label', () => {
    expect(cashSaleConfirmation(15000, 'GNF')).toBe('Enregistré — vente de 15 000 GNF.');
  });

  test('product confirmation names the product', () => {
    expect(productConfirmation('Riz 25kg')).toBe('Enregistré — Riz 25kg ajouté.');
  });

  test('delivery with a single item names the item, qty and amount', () => {
    expect(deliveryConfirmation([{ qty: 12, productName: 'Riz' }], 60000, 'GNF'))
      .toBe('Enregistrée — 12 Riz, 60 000 GNF payés.');
  });

  test('delivery with multiple items falls back to an item count', () => {
    expect(deliveryConfirmation(
      [{ qty: 12, productName: 'Riz' }, { qty: 5, productName: 'Huile' }],
      90000,
      'GNF',
    )).toBe('Enregistrée — 2 articles, 90 000 GNF payés.');
  });

  test('currency is not hardcoded — a non-whole-unit currency formats with decimals', () => {
    expect(cashSaleConfirmation(15.5, 'USD')).toBe('Enregistré — vente de 15.50 USD.');
  });
});
