// The client mirror of get_dashboard_kpis (src/utils/salesTotals.ts) buckets
// paid_at by the device's LOCAL day, same as the server does with p_tz (v242).
import { salesKpisFromList } from '@/src/utils/salesTotals';

describe('salesKpisFromList paid_at day = local day', () => {
  it('a paid_at just before local midnight counts for that local day, whatever its UTC date', () => {
    const now = new Date(2026, 2, 10, 9, 0, 0);            // local Mar 10 09:00
    const late = new Date(2026, 2, 9, 23, 30, 0);           // local Mar 9 23:30
    const sale = {
      id: 'a', status: 'paye', is_credit: false, total_amount: 1000, discount_amount: 0,
      paid_at: late.toISOString(), sale_date: '2026-03-09', created_at: late.toISOString(),
    };
    const k = salesKpisFromList([sale], now);
    expect(k.revenue_yesterday).toBe(1000);
    expect(k.revenue_month).toBe(1000);
  });
});
