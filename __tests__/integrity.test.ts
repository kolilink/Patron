import { compareServerToLocal } from '@/src/utils/integrity';

describe('compareServerToLocal', () => {
  it('equal figures → no issue', () => {
    expect(compareServerToLocal({ sales_today: 3, revenue_today: 150 }, { sales_today: 3, revenue_today: 150 })).toEqual([]);
  });
  it('rounding noise below a centime is tolerated', () => {
    expect(compareServerToLocal({ sales_today: 1, revenue_today: 10.0 }, { sales_today: 1, revenue_today: 10.004 })).toEqual([]);
  });
  it('any real divergence is named', () => {
    expect(compareServerToLocal({ sales_today: 3, revenue_today: 150 }, { sales_today: 2, revenue_today: 150 })).toEqual(['sales_today']);
    expect(compareServerToLocal({ sales_today: 3, revenue_today: 150 }, { sales_today: 3, revenue_today: 100 })).toEqual(['revenue_today']);
    expect(compareServerToLocal({ sales_today: 3, revenue_today: 150 }, { sales_today: 4, revenue_today: 1 })).toEqual(['sales_today', 'revenue_today']);
  });
});
