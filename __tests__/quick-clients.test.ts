import fs from 'fs';
import path from 'path';
import { mergeQuickClients, normalizeClientName, pendingNameActivity, salesNameActivity } from '@/src/utils/quickClients';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('quick-client picker — local truth first', () => {
  it('a name recorded offline (still in the outbox) is in the picker instantly, ranked FIRST', () => {
    const pending = pendingNameActivity([
      { operation: 'submit_carnet_debt', payload: { p_business_id: 'b', p_customer_name: 'Test' }, queuedAt: '2026-10-07T12:00:00Z' },
    ], 'b');
    const list = mergeQuickClients({
      server: [{ id: '1', name: 'Awa' }, { id: '2', name: 'Moussa' }],
      sales: [{ name: 'Awa', at: '2026-10-06T10:00:00Z' }],
      pending,
    });
    expect(list.map(c => c.name)).toEqual(['Test', 'Awa', 'Moussa']);
  });

  it('no network, no cache, no server list: sales-derived and pending names still fill the picker', () => {
    const list = mergeQuickClients({
      server: [],
      sales: salesNameActivity([{ customer_name: 'Fanta', client_id: null, created_at: '2026-10-05T00:00:00Z', status: 'credit' }]),
      pending: pendingNameActivity([{ operation: 'submit_sale', payload: { p_business_id: 'b', p_customer_name: 'Test' }, queuedAt: '2026-10-07T00:00:00Z' }], 'b'),
    });
    expect(list.map(c => c.name)).toEqual(['Test', 'Fanta']);
  });

  it('after it syncs, the same name is ONE client (server row + outbox/sales activity merge by normalized name)', () => {
    const list = mergeQuickClients({
      server: [{ id: 'srv-1', name: 'Test' }],
      sales: [{ name: ' test ', at: '2026-10-07T12:00:00Z' }],
      pending: [{ name: 'TEST', at: '2026-10-07T12:00:01Z' }],
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'srv-1', name: 'Test' });
    expect(normalizeClientName('  Aïssatou   Diallo ')).toBe('aïssatou diallo');
  });

  it('ignores cancelled sales, other businesses, refused ops and unnamed records', () => {
    expect(salesNameActivity([{ customer_name: 'X', created_at: 'a', status: 'annule' }, { customer_name: null, created_at: 'b' }])).toEqual([]);
    expect(pendingNameActivity([
      { operation: 'submit_carnet_debt', payload: { p_business_id: 'other', p_customer_name: 'Y' }, queuedAt: 'a' },
      { operation: 'submit_carnet_debt', payload: { p_business_id: 'b', p_customer_name: 'Z' }, queuedAt: 'a', status: 'failed_permanent' },
      { operation: 'submit_quick_sale', payload: { p_business_id: 'b' }, queuedAt: 'a' },
      { operation: 'submit_carnet_debt', payload: { p_business_id: 'b', p_customer_name: '  ' }, queuedAt: 'a' },
    ], 'b')).toEqual([]);
  });

  it('clients without any history keep the server order after those with activity', () => {
    const list = mergeQuickClients({ server: [{ name: 'B' }, { name: 'A' }, { name: 'C' }], sales: [{ name: 'C', at: '2026-10-01T00:00:00Z' }], pending: [] });
    expect(list.map(c => c.name)).toEqual(['C', 'B', 'A']);
  });
});

describe('wiring', () => {
  it('the hook reads the outbox + sales locally BEFORE any network, skips the network when known-offline, and tracks the outbox live', () => {
    const h = read('src/hooks/useQuickClients.ts');
    expect(h).toMatch(/readPendingNames/);
    expect(h).toMatch(/if \(isKnownOffline\(\)\) \{ setLoading\(false\); return; \}/);
    expect(h).toMatch(/\[businessId, pendingCount, refreshKey\]/);
    expect(h).toMatch(/useVentesStore\(s => s\.sales\)/);
    // the cache holds the SERVER list only; pending names are merged at read time
    expect(h).toMatch(/saveClientLedgerCache\(cacheKey, ranked\)/);
  });
  it('both screens use the one hook', () => {
    expect(read('src/components/CreditRapideCapture.tsx')).toMatch(/useQuickClients\(/);
    expect(read('app/(app)/(tabs)/vendre.tsx')).toMatch(/useQuickClients\(/);
  });
  it('a debt synced for a new name creates (or reuses) the client by (business, name) — never a duplicate', () => {
    expect(read('lib/sync.ts')).toMatch(/onConflict: 'business_id,name'/);
  });
});
