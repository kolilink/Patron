// migration_v242: get_dashboard_kpis' paid_at windows (revenue_yesterday,
// revenue_month, revenue_last_month) use the merchant's timezone (p_tz), not UTC
// midnight. paid_at is set explicitly so each case is a real boundary crossing.
import { createTestUser, createTestBusiness, adminClient } from './helpers';

async function saleAt(paidAtUtc: string) {
  const { client, userId } = await createTestUser('admin');
  const businessId = await createTestBusiness(client, 'Boutique TZ');
  const { data: orderId, error } = await client.rpc('submit_quick_sale', {
    p_business_id: businessId, p_seller_id: userId, p_unit_price: 100000,
  });
  expect(error).toBeNull();
  const { error: upErr } = await adminClient().from('sale_orders').update({ paid_at: paidAtUtc }).eq('id', orderId as string);
  expect(upErr).toBeNull();
  return { client, businessId };
}
type Kpis = { revenue_yesterday: number; revenue_month: number; revenue_last_month: number };
const kpis = async (c: Awaited<ReturnType<typeof saleAt>>, today: string, tz?: string) => {
  const { data, error } = await c.client.rpc('get_dashboard_kpis', { p_business_id: c.businessId, p_today: today, p_tz: tz ?? null });
  expect(error).toBeNull();
  return data as Kpis;
};

describe('get_dashboard_kpis revenue windows follow the merchant timezone (v242)', () => {
  it('New York 11:30 PM sale is YESTERDAY the next local day (UTC would call it today)', async () => {
    const c = await saleAt('2026-03-10T03:30:00Z'); // = 2026-03-09 23:30 America/New_York (EDT)
    expect((await kpis(c, '2026-03-10', 'America/New_York')).revenue_yesterday).toBe(100000);
    expect((await kpis(c, '2026-03-10')).revenue_yesterday).toBe(0);      // legacy / UTC behaviour unchanged
    expect((await kpis(c, '2026-03-10', 'UTC')).revenue_yesterday).toBe(0);
  });

  it('Auckland 1:30 AM sale is TODAY, not yesterday (UTC would call it yesterday)', async () => {
    const c = await saleAt('2026-03-09T12:30:00Z'); // = 2026-03-10 01:30 Pacific/Auckland (NZDT)
    expect((await kpis(c, '2026-03-10', 'Pacific/Auckland')).revenue_yesterday).toBe(0);
    expect((await kpis(c, '2026-03-10')).revenue_yesterday).toBe(100000);
  });

  it('a sale at 10 PM New York on Mar 31 belongs to MARCH, not April, once the local date is Apr 2', async () => {
    const c = await saleAt('2026-04-01T02:00:00Z'); // = 2026-03-31 22:00 America/New_York
    const ny = await kpis(c, '2026-04-02', 'America/New_York');
    expect(ny.revenue_last_month).toBe(100000);
    expect(ny.revenue_month).toBe(0);
    const utc = await kpis(c, '2026-04-02');
    expect(utc.revenue_last_month).toBe(0);
    expect(utc.revenue_month).toBe(100000);
  });

  it('an unknown timezone name falls back to UTC instead of erroring', async () => {
    const c = await saleAt('2026-03-10T03:30:00Z');
    expect((await kpis(c, '2026-03-10', 'Not/AZone')).revenue_yesterday).toBe(0);
  });

  it('_resolve_tz is not callable by an API role', async () => {
    const { client } = await createTestUser('admin');
    const { error } = await client.rpc('_resolve_tz', { p_tz: 'UTC' });
    expect(error).not.toBeNull();
  });
});
