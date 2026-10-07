import { applyPendingProductOps, applyProductOp } from '@/lib/pendingProducts';
import type { Product } from '@/src/types';

const prod = (over: Partial<Product>): Product => ({
  id: 'p1', business_id: 'b', name: 'Riz', sku: null, category: null, unit: 'sac',
  cost_price: 10, sale_price: 15, reorder_level: 2, stock_qty: 10, archived: false,
  supplier_id: null, purchase_date: null, bulk_price: null, bulk_min_qty: null, has_variants: false,
  created_at: 'x', updated_at: 'x', ...over,
} as Product);

describe('pending product ops overlay', () => {
  it('a queued create shows up (prices converted from cents), sorted, and is not added twice once the server has it', () => {
    const row = { id: 'p2', business_id: 'b', name: 'Aa', unit: 'u', cost_price: 500, sale_price: 900, stock_qty: 4, reorder_level: 0, archived: false, bulk_price: null };
    const withNew = applyPendingProductOps([prod({})], [{ operation: 'create_product', payload: { product: row } }]);
    expect(withNew.map(p => p.id)).toEqual(['p2', 'p1']);
    expect(withNew[0].sale_price).toBe(9);
    expect(withNew[0].stock_qty).toBe(4);
    const again = applyPendingProductOps(withNew, [{ operation: 'create_product', payload: { product: row } }]);
    expect(again).toHaveLength(2);
  });

  it('a queued edit patches only that product (cents → units)', () => {
    const out = applyPendingProductOps([prod({}), prod({ id: 'p9', name: 'Zz' })], [{ operation: 'update_product', payload: { id: 'p1', sale_price: 2000, name: 'Riz parfumé' } }]);
    expect(out.find(p => p.id === 'p1')).toMatchObject({ sale_price: 20, name: 'Riz parfumé' });
    expect(out.find(p => p.id === 'p9')!.sale_price).toBe(15);
  });

  it('stock adjustments are relative, floored at 0, and stack in queue order', () => {
    const ops = [
      { operation: 'adjust_stock_move', payload: { p_product_id: 'p1', p_type: 'perte', p_qty: 3 } },
      { operation: 'adjust_stock_move', payload: { p_product_id: 'p1', p_type: 'entree', p_qty: 1 } },
    ];
    expect(applyPendingProductOps([prod({})], ops)[0].stock_qty).toBe(8);
    expect(applyProductOp([prod({ stock_qty: 2 })], ops[0])[0].stock_qty).toBe(0);
  });

  it('a legacy absolute adjust_stock still applies', () => {
    const out = applyProductOp([prod({})], { operation: 'adjust_stock', payload: { productUpdate: { id: 'p1', stock_qty: 7 } } });
    expect(out[0].stock_qty).toBe(7);
  });

  it('unknown operations leave the list untouched', () => {
    const list = [prod({})];
    expect(applyProductOp(list, { operation: 'submit_sale', payload: {} })).toBe(list);
  });
});
