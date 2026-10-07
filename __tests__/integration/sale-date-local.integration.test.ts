// migration_v241: submit_carnet_debt / submit_quick_sale stamp sale_date with the
// CLIENT's local calendar date (p_sale_date), not the server's UTC CURRENT_DATE.
// Also covers get_dashboard_kpis' p_today (the read side, since v232): a sale
// recorded at a late-evening local time must not count "today" once the local
// date has moved on, and an early-morning sale east of UTC must count today.
import { createTestUser, createTestBusiness, adminClient } from './helpers';
import { randomUUID } from 'crypto';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (days: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return iso(d); };

describe('sale_date is the merchant local date (migration_v241)', () => {
  it('submit_quick_sale honors p_sale_date (yesterday: New York 11 PM) and stamps the payment with it', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique NY');
    const admin = adminClient();
    const local = shift(-1);
    const { data: orderId, error } = await client.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: userId, p_unit_price: 100000, p_sale_date: local,
    });
    expect(error).toBeNull();
    const { data: order } = await admin.from('sale_orders').select('sale_date').eq('id', orderId as string).single();
    expect(order?.sale_date).toBe(local);
    const { data: pay } = await admin.from('payments').select('date').eq('order_id', orderId as string).single();
    expect(pay?.date).toBe(local);
  });

  it('submit_quick_sale honors p_sale_date tomorrow (Auckland morning)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique AKL');
    const admin = adminClient();
    const local = shift(1);
    const { data: orderId } = await client.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: userId, p_unit_price: 100000, p_sale_date: local,
    });
    const { data: order } = await admin.from('sale_orders').select('sale_date').eq('id', orderId as string).single();
    expect(order?.sale_date).toBe(local);
  });

  it('submit_carnet_debt honors p_sale_date', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Debt');
    const admin = adminClient();
    const local = shift(-1);
    const { data: orderId, error } = await client.rpc('submit_carnet_debt', {
      p_business_id: businessId, p_seller_id: userId, p_customer_name: 'Awa', p_amount: 250000,
      p_idempotency_key: randomUUID(), p_sale_date: local,
    });
    expect(error).toBeNull();
    const { data: order } = await admin.from('sale_orders').select('sale_date').eq('id', orderId as string).single();
    expect(order?.sale_date).toBe(local);
  });

  it('omitted p_sale_date keeps the old behaviour (server date) — queued payloads from older builds replay unchanged', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Legacy');
    const admin = adminClient();
    const { data: orderId } = await client.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: userId, p_unit_price: 100000,
    });
    const { data: order } = await admin.from('sale_orders').select('sale_date').eq('id', orderId as string).single();
    expect(order?.sale_date).toBe(iso(new Date()));
  });

  it('a wildly wrong device date is clamped to the server date (cannot misfile a sale into another month)', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique Clock');
    const admin = adminClient();
    const { data: orderId } = await client.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: userId, p_unit_price: 100000, p_sale_date: shift(-40),
    });
    const { data: order } = await admin.from('sale_orders').select('sale_date').eq('id', orderId as string).single();
    expect(order?.sale_date).toBe(iso(new Date()));
  });

  it('get_dashboard_kpis: an 11 PM-local sale is "today" that evening and NOT today once the local date moves on', async () => {
    const { client, userId } = await createTestUser('admin');
    const businessId = await createTestBusiness(client, 'Boutique KPI');
    const localEvening = shift(-1);       // the local date the sale was recorded on
    const localNextDay = iso(new Date()); // after local midnight
    await client.rpc('submit_quick_sale', {
      p_business_id: businessId, p_seller_id: userId, p_unit_price: 100000, p_sale_date: localEvening,
    });
    const evening = await client.rpc('get_dashboard_kpis', { p_business_id: businessId, p_today: localEvening });
    expect((evening.data as { sales_today: number }).sales_today).toBe(1);
    const next = await client.rpc('get_dashboard_kpis', { p_business_id: businessId, p_today: localNextDay });
    expect((next.data as { sales_today: number }).sales_today).toBe(0);
    // revenue_today follows the same local sale_date rule as sales_today:
    expect((next.data as { revenue_today: number }).revenue_today).toBe(0);
    expect((evening.data as { revenue_today: number }).revenue_today).toBe(100000);
  });
});
