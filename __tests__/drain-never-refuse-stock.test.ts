// A queued sale is ground truth: stock never refuses it, a refused sale is never a debt, and a refusal a retry
// can't fix never offers "Réessayer". Asserts what the vendor SEES (balances, notice actions, product flag).
import fs from 'fs';
import path from 'path';

let mockItems: any[] = [];
jest.mock('@/lib/db', () => ({
  getAllQueueItemsForOverlay: async () => ({ ok: mockItems, corrupt: [] }),
}));
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn(), from: jest.fn() } }));
jest.mock('@/stores/auth', () => ({ useAuthStore: { getState: () => ({ session: null }) } }));
jest.mock('@/stores/ventes', () => ({ useVentesStore: { getState: () => ({ sales: [] }), subscribe: () => () => {} } }));
jest.mock('@/stores/sync', () => ({ useSyncStore: { getState: () => ({ syncing: false }), subscribe: () => () => {} } }));

import { loadRefusedOps, isDeadEndRefusal, rebuildPendingOverlay, type OverlayContext } from '@/lib/pendingOverlay';
import { selectClientSales, clientBalance, salesKpisFromList, computeLocalKpis, activeSalesTotals } from '@/src/utils/salesTotals';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const item = (id: number, operation: string, payload: object, status = 'pending', last_error: string | null = null) => ({
  id, operation, payload: JSON.stringify(payload), status, attempts: 0, last_error, idempotency_key: `key-${id}`,
  entity_type: 'vente', queued_at: '2026-10-12T10:00:00.000Z', created_at: '2026-10-12T10:00:00.000Z', next_attempt_at: '2026-10-12T10:00:00.000Z',
});
const cart = (productId = 'p-test') => [{ product_id: productId, product_name: 'Test', qty: 1, unit_price: 300000, is_bulk: false }];
const creditSale = (extra: object = {}) => ({
  p_business_id: 'biz-1', p_seller_id: 'u1', p_customer_name: 'Test', p_is_credit: true, p_total_amount: 300000, p_cart: cart(), p_idempotency_key: 'key-1', ...extra,
});
const ctx: OverlayContext = { businessId: 'biz-1', scope: 'all', currentUserId: 'u1', currentUserName: 'Fatou', now: () => '2026-10-12T10:00:00.000Z' } as any;

describe('the stock count is an estimate; the sale is the fact (server, migration v245)', () => {
  const sql = read('db/migration_v245.sql');
  it('submit_sale no longer raises for stock — it floors at 0 and flags the product', () => {
    expect(sql).not.toMatch(/RAISE EXCEPTION\s+'Stock insuffisant/);
    expect(sql).toContain('GREATEST(0, stock_qty');
    expect(sql).toContain('needs_stock_review');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS needs_stock_review');
  });
  it('no later migration can reintroduce a stock refusal inside submit_sale', () => {
    const files = fs.readdirSync(path.join(__dirname, '..', 'db')).filter(f => /^migration_v\d+\.sql$/.test(f));
    const latest = files
      .filter(f => /FUNCTION (public\.)?submit_sale\(/.test(read(`db/${f}`)))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0])).pop()!;
    const body = read(`db/${latest}`);
    expect(body.slice(body.search(/FUNCTION (public\.)?submit_sale\(/))).not.toMatch(/RAISE EXCEPTION\s+'Stock insuffisant/);
  });
});

describe('the incident: a refused credit sale must never leave a debt behind', () => {
  const refusedSale = async () => {
    mockItems = [item(1, 'submit_sale', creditSale(), 'failed_permanent', 'Stock insuffisant : Test')];
    const { sales } = await rebuildPendingOverlay([], ctx);
    return sales;
  };
  it('the refused sale stays visible in the list (with its notice) but carries the refused marker', async () => {
    const sales = await refusedSale();
    expect(sales).toHaveLength(1);
    expect(sales[0]._failedPermanent).toBe(true);
  });
  it('client carnet: owes 0, not 3 000 — no balance, no ledger sale', async () => {
    const sales = await refusedSale();
    const clientSales = selectClientSales(sales as any, 'Test', false, 'Test');
    expect(clientSales).toEqual([]);
    expect(clientBalance(clientSales, []).totalOwed).toBe(0);
  });
  it('Accueil debts and sales counters ignore it', async () => {
    const sales = (await refusedSale()) as any[];
    const today = '2026-10-12';
    const k = salesKpisFromList(sales, new Date(`${today}T12:00:00`));
    expect(k.credit_total).toBe(0);
    expect(k.sales_today).toBe(0);
    const local = computeLocalKpis({ cached: null, sales, products: [], variantsByProduct: {}, now: new Date(`${today}T12:00:00`) });
    expect(local.credit_total).toBe(0);
    expect(activeSalesTotals(sales)).toEqual({ count: 0, total: 0 });
  });
  it('the clients list builds no debtor from a refused sale', () => {
    const src = read('app/(app)/clients/index.tsx');
    expect(src).toContain('withoutRefused(sales)');
  });
});

describe('a refusal a retry can never fix offers real actions, not a dead "Réessayer"', () => {
  it('stock is never a reason any more: a legacy "Stock insuffisant" refusal retries successfully', () => {
    expect(isDeadEndRefusal('submit_sale', 'Stock insuffisant : Test')).toBe(false);
  });
  it('validation refusals of a sale are dead ends; non-sale ops keep their retry', () => {
    expect(isDeadEndRefusal('submit_sale', 'Quantité invalide pour "Test"')).toBe(true);
    expect(isDeadEndRefusal('submit_quick_sale', 'Montant invalide')).toBe(true);
    expect(isDeadEndRefusal('record_payment', 'Le montant dépasse le solde restant dû')).toBe(false);
  });
  it('the notice row for a validation refusal carries retryable=false and the product to open', async () => {
    mockItems = [item(2, 'submit_sale', creditSale({ p_idempotency_key: 'key-2' }), 'failed_permanent', 'Produit introuvable')];
    const [op] = await loadRefusedOps('biz-1');
    expect(op).toMatchObject({ retryable: false, productId: 'p-test', reason: 'Produit introuvable' });
  });
  it('a stock-reason row stays retryable', async () => {
    mockItems = [item(3, 'submit_sale', creditSale({ p_idempotency_key: 'key-3' }), 'failed_permanent', 'Stock insuffisant : Test')];
    const [op] = await loadRefusedOps('biz-1');
    expect(op.retryable).toBe(true);
  });
  it('the row offers "Ajuster le stock" and "Voir le produit" instead of Réessayer, plus Abandonner', () => {
    const src = read('src/components/RefusedOpsNotice.tsx');
    expect(src).toContain('{op.retryable && <Button label="Réessayer"');
    expect(src).toContain('!op.retryable && op.productId');
    expect(src).toContain('label="Ajuster le stock"');
    expect(src).toContain('label="Voir le produit"');
    expect(src).toContain('label="Abandonner"');
  });
});

describe('"Stock à vérifier" is visible on the product and cleared by counting the shelf', () => {
  it('the Gérer row shows the flag; an adjustment clears it', () => {
    expect(read('src/components/products/ProductManager.tsx')).toContain('Stock à vérifier');
    const store = read('stores/products.ts');
    expect(store).toMatch(/needs_stock_review\) \{[\s\S]*?update_product', \{ id: productId, needs_stock_review: false \}/);
  });
});
