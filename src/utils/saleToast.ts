// The post-sale toast: what the vendor reads ("Enregistré — vente de 2 000 GNF.") and its "Annuler" — a REAL
// reversal, not a hidden toast. Annuler enqueues a cancel_sale outbox op for this sale's local id (its idempotency
// key). While the sale is still queued the two ops net out and the stock projector gives the shelf back at once
// (lib/pendingProducts normalizeStockOps); once drained, the cancel resolves the server id from the key.
import { useVentesStore } from '@/stores/ventes';
import { cashSaleConfirmation, creditSaleConfirmation } from '@/src/utils/saveConfirmationCopy';

export function saleToastSpec(o: {
  saleKey: string | null; businessId: string; userId: string; currency: string;
  netAmount: number; isCredit: boolean; customerName?: string | null;
}): { message: string; undo?: () => Promise<void> } {
  const message = o.isCredit && o.customerName
    ? creditSaleConfirmation(o.customerName, o.netAmount, o.currency)
    : cashSaleConfirmation(o.netAmount, o.currency);
  const { saleKey } = o;
  return {
    message,
    undo: saleKey
      ? async () => { await useVentesStore.getState().cancelSale(saleKey, o.businessId, o.userId, 'Annulée depuis la confirmation'); }
      : undefined,
  };
}
