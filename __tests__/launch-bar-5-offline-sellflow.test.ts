// Launch Bar #5: "Airplane mode: full sell flow works end-to-end."
// Code-side audit (2026-10-14): submitSale is local-write-first — the ONLY
// awaited step before the success state is the durable outbox enqueue; stock
// projection and the ledger overlay re-derive from that same outbox; the
// sync kick is fire-and-forget; analytics never blocks (trackEvent is void).
// The credit "Qui" picker (useQuickClients) is local-truth-first by design.
// The one remaining network-only step was the payment sheet's loadClients:
// it read the clients table and past customer names straight from Supabase,
// so offline the picker showed NOBODY and recognition collapsed mid-sale.
// These contracts pin the audited shape so neither half can regress.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SALES = read('stores/sales.ts');
const VENDRE = read('app/(app)/(tabs)/vendre.tsx');

const slice = (src: string, start: string, end: string) => src.slice(src.indexOf(start), src.indexOf(end));

describe('submitSale never waits on the network', () => {
  const body = slice(SALES, 'submitSale: async (businessId, userId, payment', 'clearError: () => set({ error: null })');
  it('the durable enqueue is awaited before any success state', () => {
    const enqueueAt = body.indexOf("await enqueue('submit_sale', rpcPayload);");
    const successAt = body.indexOf('lastSubmitQueued: true');
    expect(enqueueAt).toBeGreaterThan(-1);
    expect(successAt).toBeGreaterThan(enqueueAt);
  });
  it('contains no Supabase call at all — server contact is the drain’s job', () => {
    expect(body).not.toContain('supabase');
    expect(body).not.toContain('.rpc(');
  });
  it('stock and ledger effects re-derive from the outbox, wrapped so they can never flip the result', () => {
    expect(body).toContain('await refreshStockFromOutbox(businessId);');
    expect(body).toContain('await useVentesStore.getState().refreshPendingOverlay();');
    expect(body).toContain('write already succeeded');
  });
});

describe('the payment sheet client picker has a local floor', () => {
  const body = slice(VENDRE, 'const loadClients = async () => {', 'const filteredClients = useMemo');
  it('falls back only when the server reads yield nobody', () => {
    expect(body).toContain('if (all.length === 0) {');
  });
  it('the fallback is the quick-picker local truth: phone-held sales + queued names, merged by name', () => {
    expect(body).toContain('salesNameActivity(localSales)');
    expect(body).toContain('pendingNameActivity(ops, businessId)');
    expect(body).toContain('mergeQuickClients({ server: [], sales: salesNameActivity(localSales), pending: pendingActs })');
    expect(body).toContain('useVentesStore.getState().sales');
    expect(body).toContain('getAllQueueItemsForOverlay()');
  });
  it('a local-read failure still leaves the new-client form able to complete the sale', () => {
    expect(body).toContain('keep the empty list');
  });
});
