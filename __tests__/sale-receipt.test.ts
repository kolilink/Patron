// Sale receipts v2 — content (variants A lined / B quick / C credit), the
// offline "Reçu" path from the submitted values, the pre-send correction of a
// still-queued op, and the capture+share sequence. All fakes, no device.

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(), from: jest.fn(),
    auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) },
  },
}));

// An in-memory outbox that applies the REAL validation chokepoint on both
// enqueue and patch, like lib/db.ts does.
type Row = { operation: string; key: string; payload: Record<string, unknown> };
const mockRows: Row[] = [];
jest.mock('@/lib/db', () => {
  const { validateOutboxPayload } = jest.requireActual('@/lib/outboxValidation');
  return {
    enqueue: jest.fn(async (operation: string, payload: Record<string, unknown>) => {
      validateOutboxPayload(operation, payload);
      mockRows.push({ operation, key: payload.p_idempotency_key as string, payload });
    }),
    patchPendingOpPayload: jest.fn(async (operation: string, key: string, mutate: (p: Record<string, unknown>) => Record<string, unknown>) => {
      const row = mockRows.find(r => r.operation === operation && r.key === key);
      if (!row) return false;
      const next = mutate({ ...row.payload });
      validateOutboxPayload(operation, next);
      row.payload = next;
      return true;
    }),
    getQueueCount: jest.fn(async () => mockRows.length),
    openDb: jest.fn(),
  };
});

const mockRefreshPendingOverlay = jest.fn().mockResolvedValue(undefined);
jest.mock('@/stores/ventes', () => ({
  useVentesStore: { getState: () => ({ refreshPendingOverlay: mockRefreshPendingOverlay }) },
}));
jest.mock('@/stores/sync', () => ({
  useSyncStore: { getState: () => ({ kick: jest.fn() }), setState: jest.fn() },
}));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));

const mockCapture = jest.fn();
jest.mock('react-native-view-shot', () => ({ captureRef: (...a: unknown[]) => mockCapture(...a) }));
const mockShare = jest.fn();
const mockAvailable = jest.fn();
jest.mock('expo-sharing', () => ({
  isAvailableAsync: () => mockAvailable(),
  shareAsync: (...a: unknown[]) => mockShare(...a),
}));

import * as fs from 'fs';
import * as path from 'path';
import { supabase } from '@/lib/supabase';
import { useSalesStore } from '@/stores/sales';
import { formatAmount } from '@/src/utils/format';
import { projectNewSale } from '@/lib/pendingOverlay';
import {
  buildReceiptContent, creditReceiptFromSubmit, linedBodyScale, MAX_RECEIPT_LINES,
  paymentMethodLabel, quickReceiptFromSubmit, receiptSourceFromVente,
  type SaleReceiptSource,
} from '@/src/utils/saleReceipt';
import {
  editPendingCarnetDebt, editPendingQuickSale, editPendingSale,
} from '@/lib/pendingReceiptEdit';
import { captureAndShareReceipt } from '@/src/components/receiptShare';

const BIZ_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const BIZ = { businessName: 'Boutique Aïcha', currency: 'USD' };
const DATE = new Date(2026, 9, 8, 14, 32);
const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

beforeEach(() => {
  mockRows.length = 0;
  jest.clearAllMocks();
});

describe('Variant B — quick sale', () => {
  it('shows label × qty, the hero total, and the method', () => {
    const c = buildReceiptContent({ kind: 'quick', ...BIZ, date: DATE, key: 'k', pending: true, unitPrice: 6000, qty: 2, label: 'Riz, sac de 5kg' });
    expect(c.variant).toBe('quick');
    expect(c.label).toBe('Riz, sac de 5kg × 2');
    expect(c.hero).toBe(formatAmount(12000, 'USD'));
    expect(c.payment).toEqual({ kind: 'paid', methodLabel: 'Espèces' });
    expect(c.contextLine).toMatch(/^Vente · /);
  });
  it('skips the label row when absent, but never loses a quantity > 1', () => {
    const one = buildReceiptContent({ kind: 'quick', ...BIZ, date: DATE, key: null, pending: false, unitPrice: 500, qty: 1, label: null });
    expect(one.label).toBeUndefined();
    const many = buildReceiptContent({ kind: 'quick', ...BIZ, date: DATE, key: null, pending: false, unitPrice: 500, qty: 3, label: '  ' });
    expect(many.label).toBe('Quantité : 3');
  });
});

describe('Variant C — credit', () => {
  it('greets by first name (shared firstName helper): "Bonjour Aïcha," for "Aïcha Diallo"', () => {
    const c = buildReceiptContent({ kind: 'credit', ...BIZ, date: DATE, key: 'k', pending: true, clientName: 'Aïcha Diallo', amount: 25000 });
    expect(c.greeting).toBe('Bonjour Aïcha,');
    expect(c.hero).toBe(`Crédit : ${formatAmount(25000, 'USD')}`);
    expect(c.contextLine).toMatch(/^Crédit du /);
  });
  it('empty name → "Bonjour,"', () => {
    expect(buildReceiptContent({ kind: 'credit', ...BIZ, date: DATE, key: null, pending: false, clientName: '', amount: 1 }).greeting).toBe('Bonjour,');
  });
  it('never says "dette" or "en retard"', () => {
    const c = buildReceiptContent({ kind: 'credit', ...BIZ, date: DATE, key: null, pending: false, clientName: 'Aïcha', amount: 10 });
    expect(JSON.stringify(c).toLowerCase()).not.toMatch(/dette|en retard/);
  });
});

describe('Variant A — lined', () => {
  const sale = (over: Partial<SaleReceiptSource> = {}): SaleReceiptSource => ({
    kind: 'sale', ...BIZ, date: DATE, key: 'k', pending: true,
    lines: [{ name: 'Riz 5kg', qty: 2, unitPrice: 6000 }, { name: 'Huile', qty: 1, unitPrice: 3000 }],
    discount: 0, paid: 15000, method: 'especes', isCredit: false, clientName: null, ...over,
  });
  it('paid in full: lines, net, "Payé ✓ · Espèces", time in the context', () => {
    const c = buildReceiptContent(sale());
    expect(c.lines?.map(l => l.lineTotal)).toEqual([formatAmount(12000, 'USD'), formatAmount(3000, 'USD')]);
    expect(c.totals).toEqual({ subtotal: formatAmount(15000, 'USD'), discount: undefined, net: formatAmount(15000, 'USD') });
    expect(c.payment).toEqual({ kind: 'paid', methodLabel: 'Espèces' });
    expect(c.contextLine).toMatch(/, 14:32$/);
  });
  it('discount appears only when > 0 and net is after it', () => {
    const c = buildReceiptContent(sale({ discount: 1000, paid: 14000 }));
    expect(c.totals?.discount).toBe(`−${formatAmount(1000, 'USD')}`);
    expect(c.totals?.net).toBe(formatAmount(14000, 'USD'));
    expect(c.payment?.kind).toBe('paid');
  });
  it('credit / partial: received, remaining, and "Pour {first name}"', () => {
    const c = buildReceiptContent(sale({ paid: 5000, isCredit: true, clientName: 'Aïcha Diallo', method: 'especes' }));
    expect(c.payment).toEqual({ kind: 'credit', received: formatAmount(5000, 'USD'), remaining: formatAmount(10000, 'USD') });
    expect(c.clientName).toBe('Aïcha');
  });
  it('full credit shows the whole net as remaining and no "Reçu"', () => {
    const c = buildReceiptContent(sale({ paid: 0, isCredit: true }));
    expect(c.payment).toEqual({ kind: 'credit', received: undefined, remaining: formatAmount(15000, 'USD') });
  });
  it('collapses a long sale into "+ N autres articles" and shrinks the body to fit', () => {
    const lines = Array.from({ length: 9 }, (_, i) => ({ name: `Article ${i}`, qty: 1, unitPrice: 100 }));
    const c = buildReceiptContent(sale({ lines, paid: 0, isCredit: true, discount: 50, clientName: 'Aïcha' }));
    expect(c.lines).toHaveLength(MAX_RECEIPT_LINES - 1);
    expect(c.moreLines).toBe('+ 5 autres articles');
    expect(c.totals?.net).toBe(formatAmount(850, 'USD'));   // totals still cover every line
    expect(linedBodyScale(c)).toBeLessThan(1);
    expect(linedBodyScale(buildReceiptContent(sale()))).toBe(1);
  });
});

describe('payment labels', () => {
  it('maps every stored method to a printed label', () => {
    expect(paymentMethodLabel('especes')).toBe('Espèces');
    expect(['orange', 'mtn', 'moov', 'digital'].map(paymentMethodLabel)).toEqual(Array(4).fill('Mobile Money'));
    expect(paymentMethodLabel('carte')).toBe('Carte');
    expect(paymentMethodLabel('virement')).toBe('Virement');
    expect(paymentMethodLabel(null)).toBeUndefined();
  });
});

describe('(a) offline quick sale → "Reçu" from the submitted values, zero network', () => {
  it('builds Variant B from the store result without touching supabase', async () => {
    const r = await useSalesStore.getState().submitQuickSale(BIZ_ID, USER_ID, 600000, 2, ' Riz ');
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ unitPriceCents: 600000, qty: 2, label: 'Riz' });
    expect(r.idempotencyKey).toBe(mockRows[0].key);
    const c = buildReceiptContent(quickReceiptFromSubmit(r, BIZ, DATE));
    expect(c.hero).toBe(formatAmount(12000, 'USD'));
    expect(c.label).toBe('Riz × 2');
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });
  it('a failed write reports ok:false (no receipt offered)', async () => {
    const r = await useSalesStore.getState().submitQuickSale(BIZ_ID, USER_ID, 0, 1);
    expect(r.ok).toBe(false);
  });
});

describe('(b) pending quick credit → receipt from the overlay-projected amount, no network', () => {
  it('a carnet entry projects amount-only and renders Variant C', async () => {
    const r = await useSalesStore.getState().submitCarnetDebt(BIZ_ID, USER_ID, 'Aïcha Diallo', 2500000, null);
    expect(r).toMatchObject({ ok: true, customerName: 'Aïcha Diallo', amountCents: 2500000 });
    const row = mockRows[0];
    const projected = projectNewSale('submit_carnet_debt', row.payload, DATE.toISOString(), { currentUserId: USER_ID, currentUserName: 'Moi', currentBusinessId: BIZ_ID } as never, row.key)!;
    expect(projected._pending).toBe(true);
    const src = receiptSourceFromVente(projected as never, BIZ);
    expect(src.kind).toBe('credit');
    const c = buildReceiptContent(src);
    expect(c.greeting).toBe('Bonjour Aïcha,');
    expect(c.hero).toBe(`Crédit : ${formatAmount(25000, 'USD')}`);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
  it('credit receipts built straight from the submit result match', () => {
    const c = buildReceiptContent(creditReceiptFromSubmit({ idempotencyKey: 'k', customerName: 'Aïcha Diallo', amountCents: 2500000 }, BIZ, DATE));
    expect(c.hero).toBe(`Crédit : ${formatAmount(25000, 'USD')}`);
  });
});

describe('receiptSourceFromVente — every Ventes row gets a truthful receipt', () => {
  const base = { id: 'sale-1', created_at: DATE.toISOString(), status: 'paye', total_amount: 9000 };
  it('a plain cash sale (amount_paid undefined) reads as PAID, never as credit', () => {
    const src = receiptSourceFromVente({ ...base, lines: [{ product_id: 'p1', product_name: 'Riz', qty: 3, unit_price: 3000 }], payments: [{ method: 'especes', amount: 9000 }] }, BIZ);
    const c = buildReceiptContent(src);
    expect(c.payment).toEqual({ kind: 'paid', methodLabel: 'Espèces' });
  });
  it('a pending quick sale from the overlay renders Variant B with its label', () => {
    const src = receiptSourceFromVente({ ...base, _pending: true, lines: [{ product_id: '', product_name: 'Riz, sac', qty: 2, unit_price: 6000 }], payments: [{ method: 'especes', amount: 12000 }], total_amount: 12000 }, BIZ);
    expect(src.kind).toBe('quick');
    expect(src.key).toBe('sale-1');
    expect(src.pending).toBe(true);
    expect(buildReceiptContent(src).label).toBe('Riz, sac × 2');
  });
  it('a synced sale with no cached lines still gets an amount-only receipt (never silent)', () => {
    expect(receiptSourceFromVente({ ...base }, BIZ).kind).toBe('quick');
    expect(receiptSourceFromVente({ ...base, status: 'credit', is_credit: true, customer_name: 'Aïcha' }, BIZ).kind).toBe('credit');
  });
  it('synced rows are not editable pre-send (no key, not pending)', () => {
    const src = receiptSourceFromVente({ ...base }, BIZ);
    expect(src.pending).toBe(false);
    expect(src.key).toBeNull();
  });
});

describe('(c) pre-send edit of a quick sale patches the queued payload', () => {
  it('rewrites p_unit_price / p_qty / p_label, keeps the idempotency key, and the receipt reflects it', async () => {
    const r = await useSalesStore.getState().submitQuickSale(BIZ_ID, USER_ID, 600000, 1, 'Riz');
    mockRefreshPendingOverlay.mockClear();
    const res = await editPendingQuickSale(r.idempotencyKey, { unitPrice: 7000, qty: 3, label: ' Riz parfumé ' });
    expect(res).toEqual({ ok: true });
    const row = mockRows[0];
    expect(row.payload).toMatchObject({ p_unit_price: 700000, p_qty: 3, p_label: 'Riz parfumé', p_idempotency_key: r.idempotencyKey });
    expect(mockRows).toHaveLength(1);
    expect(mockRefreshPendingOverlay).toHaveBeenCalled();
    // what gets captured is rebuilt from the persisted payload
    const projected = projectNewSale('submit_quick_sale', row.payload, DATE.toISOString(), { currentUserId: USER_ID, currentUserName: '', currentBusinessId: BIZ_ID } as never, row.key)!;
    const c = buildReceiptContent(receiptSourceFromVente(projected as never, BIZ));
    expect(c.hero).toBe(formatAmount(21000, 'USD'));
    expect(c.label).toBe('Riz parfumé × 3');
  });
});

describe('(d) pre-send edit of a credit patches p_amount', () => {
  it('rewrites the amount only', async () => {
    const r = await useSalesStore.getState().submitCarnetDebt(BIZ_ID, USER_ID, 'Aïcha', 1000000, null);
    const res = await editPendingCarnetDebt(r.idempotencyKey, { amount: 12500 });
    expect(res).toEqual({ ok: true });
    expect(mockRows[0].payload).toMatchObject({ p_amount: 1250000, p_customer_name: 'Aïcha', p_idempotency_key: r.idempotencyKey });
  });
});

describe('pre-send edit of a cart sale', () => {
  it('patches p_cart, total and discount; a fully-paid sale stays fully paid at the new price', async () => {
    mockRows.push({
      operation: 'submit_sale', key: '11111111-1111-4111-8111-111111111111',
      payload: {
        p_business_id: '22222222-2222-4222-8222-222222222222', p_seller_id: '33333333-3333-4333-8333-333333333333',
        p_customer_name: null, p_sale_date: '2026-10-08', p_total_amount: 1500000, p_discount_amount: 0, p_is_credit: false,
        p_cart: [
          { product_id: '44444444-4444-4444-8444-444444444444', qty: 2, unit_price: 600000, is_bulk: false, product_name: 'Riz', variant_id: null, variant_name: null },
          { product_id: '55555555-5555-4555-8555-555555555555', qty: 1, unit_price: 300000, is_bulk: false, product_name: 'Huile', variant_id: null, variant_name: null },
        ],
        p_pay_method: 'especes', p_pay_amount: 1500000, p_pay_ref: null,
        p_idempotency_key: '11111111-1111-4111-8111-111111111111', p_client_id: null,
      },
    });
    const res = await editPendingSale('11111111-1111-4111-8111-111111111111', { lines: [{ qty: 3, unitPrice: 6000 }, { qty: 1, unitPrice: 3000 }], discount: 1000 });
    expect(res).toEqual({ ok: true });
    const p = mockRows[0].payload as Record<string, unknown> & { p_cart: { qty: number; unit_price: number }[] };
    expect(p.p_cart.map(l => [l.qty, l.unit_price])).toEqual([[3, 600000], [1, 300000]]);
    expect(p.p_total_amount).toBe(2100000);
    expect(p.p_discount_amount).toBe(100000);
    expect(p.p_pay_amount).toBe(2000000);
  });
});

describe('(e) invalid edits are refused in French and write nothing', () => {
  it('quick: negative / zero price and qty 0', async () => {
    const r = await useSalesStore.getState().submitQuickSale(BIZ_ID, USER_ID, 600000, 1);
    const before = JSON.stringify(mockRows[0].payload);
    for (const bad of [{ unitPrice: -5, qty: 1 }, { unitPrice: 0, qty: 1 }, { unitPrice: 100, qty: 0 }]) {
      const res = await editPendingQuickSale(r.idempotencyKey, { ...bad, label: '' });
      expect(res.ok).toBe(false);
      expect((res as { error: string }).error).toMatch(/prix|quantité/i);
    }
    expect(JSON.stringify(mockRows[0].payload)).toBe(before);
  });
  it('credit: zero / negative amount', async () => {
    const r = await useSalesStore.getState().submitCarnetDebt(BIZ_ID, USER_ID, 'Aïcha', 1000, null);
    const before = JSON.stringify(mockRows[0].payload);
    expect((await editPendingCarnetDebt(r.idempotencyKey, { amount: 0 })).ok).toBe(false);
    expect((await editPendingCarnetDebt(r.idempotencyKey, { amount: -3 })).ok).toBe(false);
    expect(JSON.stringify(mockRows[0].payload)).toBe(before);
  });
  it('sale: qty 0, negative price, discount above the total', async () => {
    for (const bad of [
      { lines: [{ qty: 0, unitPrice: 10 }], discount: 0 },
      { lines: [{ qty: 1, unitPrice: -1 }], discount: 0 },
      { lines: [{ qty: 1, unitPrice: 10 }], discount: 50 },
      { lines: [], discount: 0 },
    ]) {
      const res = await editPendingSale('11111111-1111-4111-8111-111111111111', bad);
      expect(res.ok).toBe(false);
    }
    expect(mockRows).toHaveLength(0);
  });
  it('an op that already left the outbox says so honestly', async () => {
    const res = await editPendingQuickSale('99999999-9999-4999-8999-999999999999', { unitPrice: 10, qty: 1, label: '' });
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/Déjà envoyé/) });
  });
});

describe('(f) the rush loop is never interrupted by a receipt', () => {
  it('capture components never open a modal/navigate on submit — onReceipt is only reachable from a tap', () => {
    for (const f of ['src/components/VenteRapideCapture.tsx', 'src/components/CreditRapideCapture.tsx']) {
      const src = read(f);
      expect(src).not.toMatch(/SaleReceiptSheet|ReceiptPanel|router\.push/);
      const calls = src.match(/onReceipt\(/g) ?? [];
      expect(calls.length).toBe(1);
      expect(src).toMatch(/<ReceiptLink[^>]*onPress=\{\(\) => onReceipt\(receipt\)\}/);
    }
  });
  it('the host only sets the receipt from the link (onReceipt) or clears it', () => {
    const src = read('src/components/QuickCaptureSheet.tsx');
    expect(src.match(/setReceipt\(/g)?.length).toBe(2); // reset on open + "Retour"
    expect(src).toMatch(/onReceipt=\{setReceipt\}/);
  });
  it('the form resets BEFORE the link matters: submit never awaits the receipt', () => {
    expect(read('src/components/VenteRapideCapture.tsx')).not.toMatch(/await[^\n]*[Rr]eceipt/);
  });
});

describe('(h) sharing: no race, offline, one helper', () => {
  it('capture → share in order, with zero network', async () => {
    mockCapture.mockResolvedValue('file:///r.png');
    mockAvailable.mockResolvedValue(true);
    mockShare.mockResolvedValue(undefined);
    const ref = { current: {} } as never;
    expect(await captureAndShareReceipt(ref, 'Partager le reçu')).toBe('shared');
    expect(mockCapture).toHaveBeenCalledWith(ref, expect.objectContaining({ format: 'png', width: 1080, height: 1350 }));
    expect(mockShare).toHaveBeenCalledWith('file:///r.png', expect.objectContaining({ mimeType: 'image/png' }));
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
  it('reports unavailable / failed instead of throwing', async () => {
    mockCapture.mockResolvedValue('file:///r.png');
    mockAvailable.mockResolvedValue(false);
    expect(await captureAndShareReceipt({ current: {} } as never, 't')).toBe('unavailable');
    mockCapture.mockRejectedValue(new Error('boom'));
    expect(await captureAndShareReceipt({ current: {} } as never, 't')).toBe('failed');
    expect(await captureAndShareReceipt({ current: null } as never, 't')).toBe('failed');
  });
  it('the share helper has no timers and no connectivity gate', () => {
    const src = read('src/components/receiptShare.ts').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/setTimeout|isKnownOffline|NetInfo|connectivity|supabase/);
  });
  it('the 2.2s auto-dismiss that raced the share is gone, and the old renderer is deleted', () => {
    const vendre = read('app/(app)/(tabs)/vendre.tsx');
    expect(vendre).not.toMatch(/2200/);
    expect(vendre).not.toMatch(/captureRef|Sharing\.|SaleReceiptView|sharingReceipt/);
    expect(fs.existsSync(path.join(root, 'src/components/ui/SaleReceiptView.tsx'))).toBe(false);
    const ventes = read('app/(app)/ventes/index.tsx');
    expect(ventes).not.toMatch(/captureRef|Sharing\.|SaleReceiptView/);
  });
  it('the reminder and the sale receipts share one capture helper', () => {
    expect(read('src/components/DebtReminderSheet.tsx')).toMatch(/captureAndShareReceipt/);
    expect(read('src/components/ReceiptPanel.tsx')).toMatch(/captureAndShareReceipt/);
  });
});
