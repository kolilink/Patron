import {
  creditSaleConfirmation,
  repaymentConfirmation,
  cashSaleConfirmation,
  productConfirmation,
  deliveryConfirmation,
} from '@/src/utils/saveConfirmationCopy';
import { useSaveConfirmationStore } from '@/stores/saveConfirmation';

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

describe('useSaveConfirmationStore', () => {
  beforeEach(() => {
    useSaveConfirmationStore.setState({
      visible: false, message: '', tone: 'success', expired: false, undo: undefined, onEdit: undefined, undoing: false,
    });
  });

  test('show() makes the banner visible with the given message and resets expired', () => {
    useSaveConfirmationStore.getState().show({ message: 'Enregistré — vente de 1 000 GNF.' });
    const state = useSaveConfirmationStore.getState();
    expect(state.visible).toBe(true);
    expect(state.message).toBe('Enregistré — vente de 1 000 GNF.');
    expect(state.expired).toBe(false);
  });

  test('hide() clears visibility and any undo/onEdit callbacks', () => {
    useSaveConfirmationStore.getState().show({ message: 'x', undo: () => {}, onEdit: () => {} });
    useSaveConfirmationStore.getState().hide();
    const state = useSaveConfirmationStore.getState();
    expect(state.visible).toBe(false);
    expect(state.undo).toBeUndefined();
    expect(state.onEdit).toBeUndefined();
  });

  test('expire() flips expired without touching visibility, so the UI can swap Annuler for Modifier', () => {
    useSaveConfirmationStore.getState().show({ message: 'x' });
    useSaveConfirmationStore.getState().expire();
    const state = useSaveConfirmationStore.getState();
    expect(state.visible).toBe(true);
    expect(state.expired).toBe(true);
  });

  test('runUndo() — unsynced/synced compensating action: calls undo() and then closes the banner', async () => {
    const undo = jest.fn().mockResolvedValue(undefined);
    useSaveConfirmationStore.getState().show({ message: 'x', undo });
    await useSaveConfirmationStore.getState().runUndo();
    expect(undo).toHaveBeenCalledTimes(1);
    const state = useSaveConfirmationStore.getState();
    expect(state.visible).toBe(false);
    expect(state.undoing).toBe(false);
  });

  test('runUndo() is a no-op when there is no undo callback (post-window / no-reversal-path case)', async () => {
    useSaveConfirmationStore.getState().show({ message: 'x' });
    await useSaveConfirmationStore.getState().runUndo();
    // Still visible — falls through to the expire()/onEdit hand-off instead
    // of silently vanishing, per the "never a silent deletion" requirement.
    expect(useSaveConfirmationStore.getState().visible).toBe(true);
  });

  test('runUndo() resets undoing to false even if the undo callback throws', async () => {
    const undo = jest.fn().mockRejectedValue(new Error('cancel_sale failed'));
    useSaveConfirmationStore.getState().show({ message: 'x', undo });
    await expect(useSaveConfirmationStore.getState().runUndo()).rejects.toThrow();
    expect(useSaveConfirmationStore.getState().undoing).toBe(false);
  });
});
