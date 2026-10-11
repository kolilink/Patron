// QuickAddProductSheet logic: validation, Modèles conversion, derived total,
// coût réel (fee spreading), autocomplete, and the offline create path.

const enqueued: { op: string; payload: any }[] = [];
const rpcCalls: string[] = [];

jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  enqueue: async (op: string, payload: any) => { enqueued.push({ op, payload }); },
  // the real outbox read, fed by what enqueue captured (entity_type 'produit' as db.ts stamps it)
  getAllQueueItemsForOverlay: async () => ({
    ok: enqueued.map((q, i) => ({ id: i + 1, operation: q.op, payload: JSON.stringify(q.payload), status: 'pending', entity_type: 'produit' })),
    corrupt: [],
  }),
  getProductCache: async () => [],
  getQueueCount: async () => enqueued.length,
}));
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: async (fn: string) => { rpcCalls.push(fn); throw new Error('network down'); },
    from: () => { rpcCalls.push('from'); throw new Error('network down'); },
    auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) },
  },
}));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn(), resolveSellerDisplayName: jest.fn() }));

import {
  EMPTY_QUICK_ADD, addVariant, computeCostLine, derivedTotalPieces, needsPurchasePrice,
  patchVariant, removeVariant, resolvedVariantPrice, setModels, suggestProducts,
  toQuickAddPayload, validateQuickAdd, type QuickAddState,
} from '@/src/utils/quickAddProduct';
import { formatAmount as realFormatAmount } from '@/src/utils/format';
import { useProductStore } from '@/stores/products';
import { drainQueue } from '@/lib/sync';

const C = 'GNF';
const st = (over: Partial<QuickAddState> = {}): QuickAddState => ({ ...EMPTY_QUICK_ADD, ...over });
const prod = (id: string, name: string, over: any = {}) => ({ id, name, sale_price: 1000, cost_price: 500, ...over } as any);

describe('validation (unchanged rule: name + price > 0)', () => {
  it('requires a name', () => expect(validateQuickAdd(st({ price: '1 000' }), C)).toBe('Indiquez le nom'));
  it('requires price > 0', () => {
    expect(validateQuickAdd(st({ name: 'Riz' }), C)).toMatch(/prix de vente/);
    expect(validateQuickAdd(st({ name: 'Riz', price: '0' }), C)).toMatch(/prix de vente/);
  });
  it('nothing else is required', () => expect(validateQuickAdd(st({ name: 'Riz', price: '5 000' }), C)).toBeNull());
  it('with Modèles, every row needs a name', () => {
    const s = setModels(st({ name: 'T-shirt', price: '5 000' }), true);
    expect(validateQuickAdd(s, C)).toBe('Chaque modèle doit avoir un nom');
    expect(validateQuickAdd(patchVariant(s, s.variants[0].key, { name: 'M' }), C)).toBeNull();
  });
});

describe('Modèles toggle conversion', () => {
  it('ON: single qty becomes the first row; its price follows the starting price', () => {
    const on = setModels(st({ name: 'T', price: '5 000', qty: '12' }), true);
    expect(on.models).toBe(true);
    expect(on.variants).toHaveLength(1);
    expect(on.variants[0].qty).toBe('12');
    expect(on.variants[0].touched).toBe(false);
    expect(resolvedVariantPrice(on.variants[0], on, C)).toBe(5000);
  });
  it('OFF: the derived total becomes the single qty (nothing lost)', () => {
    let s = setModels(st({ name: 'T', price: '5 000', qty: '1' }), true);
    s = patchVariant(s, s.variants[0].key, { qty: '4' });
    s = addVariant(s);
    s = patchVariant(s, s.variants[1].key, { qty: '6' });
    const off = setModels(s, false);
    expect(off.qty).toBe('10');
    expect(off.price).toBe('5 000');
  });
  it('OFF then ON again restores the rows', () => {
    let s = setModels(st({ price: '100' }), true);
    s = patchVariant(s, s.variants[0].key, { name: 'M', qty: '3' });
    const back = setModels(setModels(s, false), true);
    expect(back.variants[0]).toMatchObject({ name: 'M', qty: '3' });
  });
});

describe('prefilled vs edited rows', () => {
  it('untouched rows follow the starting price live; typing marks the row touched and it stops following', () => {
    let s = setModels(st({ price: '5 000' }), true);
    s = addVariant(s);
    const [a, b] = s.variants.map(v => v.key);
    s = patchVariant(s, a, { price: '7 000' });
    s = { ...s, price: '6 000' };
    const [ra, rb] = s.variants;
    expect(ra.touched).toBe(true);
    expect(resolvedVariantPrice(ra, s, C)).toBe(7000);
    expect(rb.touched).toBe(false);
    expect(resolvedVariantPrice(rb, s, C)).toBe(6000);
    expect(b).toBe(rb.key);
  });
  it('editing name/qty does not mark the price touched', () => {
    let s = setModels(st({ price: '100' }), true);
    s = patchVariant(s, s.variants[0].key, { name: 'M', qty: '2' });
    expect(s.variants[0].touched).toBe(false);
  });
});

describe('derived total', () => {
  it('sums row quantities live and ignores junk', () => {
    let s = setModels(st({ price: '1' }), true);
    s = addVariant(addVariant(s));
    s = patchVariant(s, s.variants[0].key, { qty: '3' });
    s = patchVariant(s, s.variants[1].key, { qty: '4' });
    s = patchVariant(s, s.variants[2].key, { qty: '' });
    expect(derivedTotalPieces(s.variants)).toBe(7);
    s = removeVariant(s, s.variants[1].key);
    expect(derivedTotalPieces(s.variants)).toBe(3);
  });
});

describe('coût réel par pièce', () => {
  const f = (n: number) => realFormatAmount(n, C).split(' ').join(' ');
  it('is not computable without a purchase price or fees', () => {
    expect(computeCostLine(st({ price: '1 000' }), C)).toBeNull();
  });
  it('spreads fees over the pieces: 3 × 1 000 + 3 000 fees over 3 = 2 000/piece', () => {
    const c = computeCostLine(st({ price: '3 000', qty: '3', purchasePrice: '1 000', fees: '3 000' }), C)!;
    expect(c.unitCost).toBe(2000);
    expect(f(c.profit!)).toBe('1 000 GNF');
  });
  it('with Modèles the divisor is the derived total', () => {
    let s = setModels(st({ price: '3 000', purchasePrice: '1 000', fees: '3 000' }), true);
    s = patchVariant(s, s.variants[0].key, { qty: '1' });
    s = addVariant(s);
    s = patchVariant(s, s.variants[1].key, { qty: '2' });
    expect(computeCostLine(s, C)!.unitCost).toBe(2000);
  });
  it('profit is null until a sale price exists; a loss is negative', () => {
    expect(computeCostLine(st({ purchasePrice: '500', qty: '1' }), C)!.profit).toBeNull();
    expect(computeCostLine(st({ price: '300', purchasePrice: '500', qty: '1' }), C)!.profit).toBe(-200);
  });
});

describe('payload', () => {
  it('draft: no purchase price → cost 0, sellable at once, qty default 1', () => {
    const p = toQuickAddPayload(st({ name: ' Riz ', price: '5 000' }), C);
    expect(p.data).toMatchObject({ name: 'Riz', cost_price: 0, sale_price: 5000, initial_stock: 1, unit: 'pcs', reorder_level: 0, supplier_id: null });
    expect(p.hasVariants).toBe(false);
  });
  it('no stock/seuil field: reorder_level is always 0', () => {
    expect(toQuickAddPayload(st({ name: 'a', price: '1' }), C).data.reorder_level).toBe(0);
  });
  it('Modèles: parent stock 0, rows carry stock + resolved prices', () => {
    let s = setModels(st({ name: 'T', price: '5 000' }), true);
    s = patchVariant(s, s.variants[0].key, { name: 'M', qty: '4' });
    s = addVariant(s);
    s = patchVariant(s, s.variants[1].key, { name: 'L', qty: '2', price: '6 000' });
    const p = toQuickAddPayload(s, C);
    expect(p.data.initial_stock).toBe(0);
    expect(p.variants).toEqual([
      expect.objectContaining({ name: 'M', stock_qty: 4, sale_price: 5000 }),
      expect.objectContaining({ name: 'L', stock_qty: 2, sale_price: 6000 }),
    ]);
  });
  it('supplier + fees flow into cost_price', () => {
    const p = toQuickAddPayload(st({ name: 'a', price: '3 000', qty: '3', purchasePrice: '1 000', fees: '3 000', supplierId: 'sup1' }), C);
    expect(p.data.cost_price).toBe(2000);
    expect(p.data.supplier_id).toBe('sup1');
  });
});

describe('autocomplete', () => {
  const list = [prod('1', 'Riz parfumé'), prod('2', 'Huile'), prod('3', 'Fromage riz'), prod('4', 'Éponge')];
  it('matches case/accent-insensitively, prefix first', () => {
    expect(suggestProducts('riz', list).map(p => p.id)).toEqual(['1', '3']);
    expect(suggestProducts('epon', list).map(p => p.id)).toEqual(['4']);
  });
  it('needs 2+ characters and returns nothing for no match', () => {
    expect(suggestProducts('r', list)).toEqual([]);
    expect(suggestProducts('zzz', list)).toEqual([]);
  });
  it('select-existing vs create: a typed name with no match yields no suggestions (create path)', () => {
    expect(suggestProducts('Savon', list)).toHaveLength(0);
  });
});

describe('Prix à fixer', () => {
  it('flags only products without a purchase price', () => {
    expect(needsPurchasePrice({ cost_price: 0 })).toBe(true);
    expect(needsPurchasePrice({ cost_price: 1200 })).toBe(false);
  });
});

describe('offline create (phone-first, same UUID)', () => {
  beforeEach(() => { enqueued.length = 0; rpcCalls.length = 0; });

  it('writes to the outbox only, product is visible locally, no network call', async () => {
    const payload = toQuickAddPayload(st({ name: 'Riz', price: '5 000', qty: '2' }), C);
    const ok = await useProductStore.getState().createProduct('biz', 'user', payload.data);
    expect(ok).toBe(true);
    expect(rpcCalls).toEqual([]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].op).toBe('create_product');
    const row = enqueued[0].payload.product;
    expect(row).toMatchObject({ name: 'Riz', sale_price: 500000, stock_qty: 2, cost_price: 0 });
    expect(enqueued[0].payload.stockMove).toMatchObject({ product_id: row.id, qty: 2 });
    // immediately visible in the grid's source list, under the same id the outbox will send
    expect(useProductStore.getState().products.some(p => p.id === row.id && p.name === 'Riz')).toBe(true);
  });
});

describe('offline create drains with the same UUID', () => {
  it('create_product replays the queued product id to create_product_with_stock', async () => {
    // Drain is covered in depth by idempotent-replay-drain.test.ts; here we
    // assert the payload this flow queues is exactly what that RPC receives.
    const id = 'fixed-uuid';
    const sent: any[] = [];
    jest.resetModules();
    jest.doMock('@/lib/db', () => ({
      ...jest.requireActual('@/lib/db'),
      getPendingOpsForDrain: async () => ({ ok: [{ id: 1, operation: 'create_product', payload: JSON.stringify({ product: { id, name: 'Riz' }, stockMove: null }), status: 'pending', attempts: 0 }], corrupt: [] }),
      deleteQueueItem: async () => {},
      rescheduleOp: async () => {},
      markOpPermanentlyFailed: async () => {},
      markOpCorrupt: async () => {},
      getPendingSupplierKeys: async () => new Set(),
    }));
    jest.doMock('@/lib/supabase', () => ({
      supabase: { rpc: async (fn: string, a: any) => { sent.push({ fn, a }); return { data: null, error: null }; }, from: () => ({}),
        auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } },
    }));
    const { drainQueue: drain } = require('@/lib/sync');
    expect((await drain()).synced).toBe(1);
    expect(sent[0].fn).toBe('create_product_with_stock');
    expect(JSON.stringify(sent[0].a)).toContain(id);
  });
});

// keep the import used so the module graph matches production
void drainQueue;

describe('polish pass: labels, currency prefix, footer', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/components/QuickAddProductSheet.tsx'), 'utf8');
  it('labels carry no currency, parenthetical or "unitaire"', () => {
    expect(src).toContain('>Je vends à<');
    expect(src).toContain('>Prix d\'achat<');
    expect(src).toContain('>Frais<');
    expect(src).not.toMatch(/unitaire|transport, etc|\$\{currency\}`\}<\/Text>|· \$\{currency\}/);
  });
  it('every decimal-pad input is a MoneyInput (currency prefix inside the field); no bare money TextInput', () => {
    const blocks = src.match(/<(TextInput|MoneyInput)\b[\s\S]*?\/>/g) as string[];
    const decimal = blocks.filter(b => b.includes('decimal-pad'));
    expect(decimal.length).toBe(4); // price, variant price, purchase, fees
    decimal.forEach(b => expect(b.startsWith('<MoneyInput')).toBe(true));
  });
  it('quantity row has no unit label', () => {
    expect(src).not.toContain('pièces</Text>\n            </View>');
    expect(src).not.toMatch(/>pièces</);
  });
  it('footer: single button, full-screen presentation, keyboard-aware inset', () => {
    expect((src.match(/label="Ajouter"/g) || []).length).toBe(1);
    expect(src).toContain('presentationStyle="fullScreen"');
    expect(src).toContain('useKeyboardVisible');
  });
});
