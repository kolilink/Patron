// Post-action confirmations never block the primary flow: first sale ever = celebration sheet (with receipt share);
// every later sale = floating pill + haptic only, grid immediately usable. Credit keeps its client sheet.
import fs from 'fs';
import path from 'path';

let kv = new Map<string, string>();
let outbox: any[] = [];
jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  getKV: jest.fn(async (k: string) => kv.get(k) ?? null),
  setKV: jest.fn(async (k: string, v: string) => { kv.set(k, v); }),
  enqueue: jest.fn(async (operation: string, payload: unknown) => { outbox.push({ operation, payload }); }),
  getQueueCount: jest.fn(async () => outbox.length),
  getAllQueueItemsForOverlay: jest.fn(async () => ({ ok: [], corrupt: [] })),
  getProductCache: jest.fn().mockResolvedValue(null),
  saveProductCache: jest.fn(),
  getVentesCache: jest.fn().mockResolvedValue(null),
  saveVentesCache: jest.fn(),
}));
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } } }));
jest.mock('@/stores/sync', () => ({ useSyncStore: { getState: () => ({ kick: jest.fn() }), setState: jest.fn() } }));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));

import { shouldShowSaleSheet, hasSeenCelebration, markCelebrationSeen, celebrationKey } from '@/src/utils/saleSheetPolicy';
import { useSalesStore } from '@/stores/sales';
import { useVentesStore } from '@/stores/ventes';
import { useProductStore } from '@/stores/products';
import { useAuthStore } from '@/stores/auth';
import { toast, useToastStore } from '@/stores/toast';
import { saleToastSpec } from '@/src/utils/saleToast';

const BIZ = 'biz-1';
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const prod = (id: string) => ({ id, business_id: BIZ, name: id, unit: 'pcs', cost_price: 50, sale_price: 200, bulk_price: null, bulk_min_qty: null, reorder_level: 0, stock_qty: 10, archived: false, has_variants: false } as any);

beforeEach(() => {
  kv = new Map(); outbox = [];
  useToastStore.getState().clear();
  useSalesStore.setState({ cart: [], submitting: false, error: null });
  useVentesStore.setState({ sales: [], salesFetchedFor: BIZ });
  useAuthStore.setState({ session: { user: { id: 'u1', name: 'F' }, activeBusiness: { id: BIZ, currency: 'GNF' }, activeMembership: { role: 'administrateur' } } } as any);
  useProductStore.setState({ products: [prod('riz'), prod('huile')] });
});

/** What vendre.tsx does around submitSale, using the same pure pieces. */
async function checkout(skipConfirmSheet = false) {
  const v = useVentesStore.getState();
  const showSheet = shouldShowSaleSheet({
    skipConfirmSheet,
    celebrationSeen: await hasSeenCelebration(BIZ),
    salesLoaded: v.salesFetchedFor === BIZ,
    priorSales: v.sales.filter(s => s.status !== 'annule' && !s._failedPermanent).length,
  });
  const ok = await useSalesStore.getState().submitSale(BIZ, 'u1', { method: 'especes', amount: 200 });
  if (ok && showSheet) await markCelebrationSeen(BIZ);
  if (ok && !showSheet) toast.saved(saleToastSpec({ saleKey: useSalesStore.getState().lastSaleKey, businessId: BIZ, userId: 'u1', currency: 'GNF', netAmount: 200, isCredit: false }));
  return { ok, showSheet };
}

describe('first sale ever keeps the celebration sheet; later sales never open one', () => {
  it('first sale → sheet (receipt share lives there), no pill yet', async () => {
    useSalesStore.getState().addToCart(prod('riz'));
    const r = await checkout();
    expect(r).toEqual({ ok: true, showSheet: true });
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(kv.get(celebrationKey(BIZ))).toBe('1');
  });

  it('second sale → NO sheet, the pill appears with Annuler, and she can add the next product immediately', async () => {
    useSalesStore.getState().addToCart(prod('riz'));
    await checkout();                                   // first
    useSalesStore.getState().addToCart(prod('huile'));
    const r = await checkout();                         // second
    expect(r.showSheet).toBe(false);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('Enregistré — vente de 200 GNF.');
    expect(toasts[0].action?.label).toBe('Annuler');
    // no dismissal tap needed: the grid is live right now
    useSalesStore.getState().addToCart(prod('riz'));
    expect(useSalesStore.getState().cart.map(l => l.product.id)).toEqual(['riz']);
  });

  it('the celebration shows once per business, even across restarts, even if the sales list is empty again', async () => {
    useSalesStore.getState().addToCart(prod('riz'));
    await checkout();
    useVentesStore.setState({ sales: [] });             // e.g. cache cleared
    useSalesStore.getState().addToCart(prod('riz'));
    expect((await checkout()).showSheet).toBe(false);
  });

  it('a business that already has sales never gets the celebration', () => {
    expect(shouldShowSaleSheet({ skipConfirmSheet: false, celebrationSeen: false, salesLoaded: true, priorSales: 12 })).toBe(false);
  });
  it('history not loaded yet → no sheet (never block a rush sale on a guess); an explicit skip always wins', () => {
    expect(shouldShowSaleSheet({ skipConfirmSheet: false, celebrationSeen: false, salesLoaded: false, priorSales: 0 })).toBe(false);
    expect(shouldShowSaleSheet({ skipConfirmSheet: true, celebrationSeen: false, salesLoaded: true, priorSales: 0 })).toBe(false);
    expect(shouldShowSaleSheet({ skipConfirmSheet: false, celebrationSeen: false, salesLoaded: true, priorSales: 0 })).toBe(true);
  });
});

describe('wiring in Vendre', () => {
  const V = read('app/(app)/(tabs)/vendre.tsx');
  it('the sheet opens only when the policy says so, and then marks the celebration seen', () => {
    expect(V).toContain('if (showSheet) { setShowConfirmSheet(true); void markCelebrationSeen(businessId); }');
    expect(V).not.toContain('if (!skipConfirmSheet) setShowConfirmSheet(true);');
  });
  it('the decision is taken BEFORE the sale is written (the new sale would otherwise count as "prior")', () => {
    expect(V.indexOf('const showSheet = shouldShowSaleSheet(')).toBeGreaterThan(-1);
    expect(V.indexOf('const showSheet = shouldShowSaleSheet(')).toBeLessThan(V.indexOf('const ok = await submitSale('));
  });
  it('with no sheet the pill is raised at once; with the sheet it waits for the sheet to close', () => {
    expect(V).toContain('if (!showSheet) { toast.saved(pendingSaveConfirmationRef.current); pendingSaveConfirmationRef.current = null; }');
    expect(V).toContain('toast.saved(pendingSaveConfirmationRef.current);'); // the on-close path still exists for the first sale
  });
  it('the credit flow still opens its client sheet (a decision needing input)', () => {
    expect(V).toContain("const openCredit = () => { setShowCartSheet(false); setPayStep('credit'); setShowPayment(true); };");
  });
});
