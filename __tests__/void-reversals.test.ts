// Undo coverage for the two SaveConfirmation write types that previously had
// none — repayment (void_payment, migration_v157.sql) and PO delivery
// (void_purchase_order_receipt, migration_v158.sql). Mocks supabase.rpc per
// this repo's existing convention (see record-payment.test.ts) — these
// verify the store calls the right RPC with the right params and reacts
// correctly to success/failure, not that the SQL function itself is correct
// (that's __tests__/integration/'s job).

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
    from: jest.fn(),
    auth: {
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
  },
}));

jest.mock('@/lib/db', () => ({
  enqueue:              jest.fn().mockResolvedValue(undefined),
  getQueueCount:        jest.fn().mockResolvedValue(0),
  openDb:               jest.fn(),
  saveVentesCache:      jest.fn().mockResolvedValue(undefined),
  getVentesCache:       jest.fn().mockResolvedValue(null),
  getCacheTimestamp:    jest.fn().mockResolvedValue(null),
  saveFournisseurCache: jest.fn().mockResolvedValue(undefined),
  getFournisseurCache:  jest.fn().mockResolvedValue(null),
  saveCommandeCache:    jest.fn().mockResolvedValue(undefined),
  getCommandeCache:     jest.fn().mockResolvedValue(null),
}));

jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn() }));
jest.mock('@/stores/products', () => ({
  useProductStore: { getState: () => ({ fetchProducts: jest.fn().mockResolvedValue(undefined) }) },
}));

import { useVentesStore, type Vente } from '@/stores/ventes';
import { useFournisseursStore } from '@/stores/fournisseurs';
import { supabase } from '@/lib/supabase';

// Generic chainable stub for supabase.from(...).select().eq().order()... —
// both fetchSales and fetchCommandes (called internally by voidPayments/
// voidPurchaseOrderReceipt to refresh after a reversal) chain several
// different query-builder methods before being awaited as a thenable.
// Rather than replicate each chain shape exactly, every method just returns
// the same object, which resolves to an empty result when awaited.
function chainable(result: { data: unknown; error: unknown } = { data: [], error: null }) {
  const obj: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'in', 'gte', 'not']) {
    obj[m] = jest.fn(() => obj);
  }
  (obj as unknown as { then: (resolve: (v: unknown) => void) => void }).then = (resolve) => resolve(result);
  return obj;
}

const creditSale: Vente = {
  id: 'sale-1',
  business_id: 'biz-1',
  customer_name: 'Aïssatou',
  client_id: null,
  seller_id: 'user-1',
  seller_name: 'Vendeur',
  status: 'paye',
  is_credit: true,
  total_amount: 1650000,
  discount_amount: 0,
  paid_at: '2026-06-30T00:00:00Z',
  sale_date: '2026-06-20',
  created_at: '2026-06-20T00:00:00Z',
  cancelled_at: null,
  cancellation_reason: null,
  profit: null,
  amount_paid: 1650000,
};

beforeEach(() => {
  useVentesStore.setState({ sales: [creditSale], saving: false, error: null });
  useFournisseursStore.setState({ commandes: [], saving: false, error: null });
  jest.clearAllMocks();
});

describe('voidPayments (repayment undo)', () => {
  it('calls void_payment once per payment id and re-fetches sales on success', async () => {
    (supabase.rpc as jest.Mock)
      .mockResolvedValueOnce({ data: { order_id: 'sale-1', amount: 1650000 }, error: null }) // void_payment
      .mockResolvedValueOnce({ data: [], error: null }); // fetchSales' underlying select, mocked loosely below

    // fetchSales uses supabase.from(...).select(...) — not exercised deeply here,
    // stub it to resolve so voidPayments' await doesn't hang.
    (supabase.from as jest.Mock).mockImplementation(() => chainable());

    const ok = await useVentesStore.getState().voidPayments(['pay-1'], 'biz-1', 'Annulée depuis la confirmation');

    expect(ok).toBe(true);
    expect(supabase.rpc).toHaveBeenCalledWith('void_payment', {
      p_payment_id: 'pay-1',
      p_business_id: 'biz-1',
      p_reason: 'Annulée depuis la confirmation',
    });
  });

  it('voids every id for a FIFO multi-sale repayment (record_client_payment fan-out)', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({ data: { order_id: 'sale-1', amount: 100 }, error: null });
    (supabase.from as jest.Mock).mockImplementation(() => chainable());

    await useVentesStore.getState().voidPayments(['pay-1', 'pay-2', 'pay-3'], 'biz-1');

    expect(supabase.rpc).toHaveBeenCalledTimes(3);
    expect((supabase.rpc as jest.Mock).mock.calls.map(c => c[1].p_payment_id)).toEqual(['pay-1', 'pay-2', 'pay-3']);
  });

  it('stops and surfaces an error if the server rejects (e.g. already voided) — no partial silent success', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({
      data: null,
      error: { message: 'Ce paiement a déjà été annulé' },
    });

    const ok = await useVentesStore.getState().voidPayments(['pay-1'], 'biz-1');

    expect(ok).toBe(false);
    expect(useVentesStore.getState().error).toBeTruthy();
  });
});

describe('recevoirCommande / voidPurchaseOrderReceipt (delivery undo)', () => {
  it('recevoirCommande returns the batch id receive_purchase_order now RETURNs', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({ data: 'batch-1', error: null });
    (supabase.from as jest.Mock).mockImplementation(() => chainable());

    const result = await useFournisseursStore.getState().recevoirCommande('po-1', 'biz-1', 'user-1');

    expect(result).toEqual({ ok: true, batchId: 'batch-1' });
  });

  it('recevoirCommande returns ok:false with no batchId on error', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({ data: null, error: { message: 'boom' } });

    const result = await useFournisseursStore.getState().recevoirCommande('po-1', 'biz-1', 'user-1');

    expect(result).toEqual({ ok: false });
  });

  it('voidPurchaseOrderReceipt calls the RPC with the batch id and re-fetches on success', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({ data: null, error: null });
    (supabase.from as jest.Mock).mockImplementation(() => chainable());

    const ok = await useFournisseursStore.getState().voidPurchaseOrderReceipt('batch-1', 'biz-1', 'user-1', 'Annulée depuis la confirmation');

    expect(ok).toBe(true);
    expect(supabase.rpc).toHaveBeenCalledWith('void_purchase_order_receipt', {
      p_batch_id: 'batch-1',
      p_business_id: 'biz-1',
      p_reason: 'Annulée depuis la confirmation',
    });
  });

  it('voidPurchaseOrderReceipt surfaces the safety refusal (stock already sold) as an error, not a crash', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({
      data: null,
      error: { message: 'Stock déjà vendu depuis cette réception — annulation impossible' },
    });

    const ok = await useFournisseursStore.getState().voidPurchaseOrderReceipt('batch-1', 'biz-1', 'user-1');

    expect(ok).toBe(false);
    expect(useFournisseursStore.getState().error).toBeTruthy();
  });
});
