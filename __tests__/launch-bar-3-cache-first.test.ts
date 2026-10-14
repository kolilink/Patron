// Launch Bar #3: "Every list renders instantly from cache — zero skeleton
// flash when data exists." The fournisseurs store's three list fetchers were
// network-first: they set loading and only fell back to cache when the network
// FAILED, so every cold open of Fournisseurs / Commandes / Dettes waited on
// the network despite a warm cache. The apports store already had the correct
// shape (paint cache first, refresh behind it, loading only when there is
// truly nothing to show). These contracts pin that shape in all three
// fetchers so a future refactor cannot quietly reintroduce the flash.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = read('stores/fournisseurs.ts');
const APPORTS = read('stores/apports.ts');

const slice = (src: string, start: string, end: string) => src.slice(src.indexOf(start), src.indexOf(end));

describe('fetchFournisseurs is cache-first', () => {
  const body = slice(F, 'fetchFournisseurs: async (businessId) => {', 'createFournisseur: async');
  it('reads the fournisseur cache before any network call and publishes it', () => {
    const cacheAt = body.indexOf('getFournisseurCache(businessId)');
    const networkAt = body.indexOf('supabase.from(');
    expect(cacheAt).toBeGreaterThan(-1);
    expect(networkAt).toBeGreaterThan(cacheAt);
    expect(body).toContain('await publishFournisseurs(businessId);');
    expect(body).toContain('await loadDebtsFromCache(businessId);');
  });
  it('sets loading only when the list is still empty after the cache head', () => {
    expect(body).toContain('if (get().fournisseurs.length === 0) set({ loading: true });');
    expect(body).not.toMatch(/if \(isStaleBusiness\(businessId\)\) return;\s*set\(\{ loading: true \}\);/);
  });
});

describe('fetchCommandes is cache-first', () => {
  const body = slice(F, 'fetchCommandes: async (businessId) => {', 'loadCommandeLines: async');
  it('reads the commande cache before any network call and publishes it', () => {
    const cacheAt = body.indexOf('getCommandeCache(businessId)');
    const networkAt = body.indexOf('supabase');
    expect(cacheAt).toBeGreaterThan(-1);
    expect(networkAt).toBeGreaterThan(cacheAt);
    expect(body).toContain('await publishCommandes(businessId);');
  });
  it('sets loading only when the list is still empty after the cache head', () => {
    expect(body).toContain('if (get().commandes.length === 0) set({ loading: true });');
  });
});

describe('fetchDebts is cache-first', () => {
  const body = slice(F, 'fetchDebts: async (businessId) => {', 'createDebt: async');
  it('paints the cached ledger before the network round-trip', () => {
    const cacheAt = body.indexOf('await loadDebtsFromCache(businessId);');
    const networkAt = body.indexOf('withTimeout(');
    expect(cacheAt).toBeGreaterThan(-1);
    expect(networkAt).toBeGreaterThan(cacheAt);
    expect(body).toContain('if (!_baseDebts || _baseDebts.businessId !== businessId)');
  });
});

describe('the precedent stays intact', () => {
  it('apports still paints its cache before the network refresh', () => {
    const body = slice(APPORTS, 'fetchApports: async (businessId) => {', 'createApport: async');
    expect(body.indexOf('getApportsCache(businessId)')).toBeLessThan(body.indexOf('supabase'));
    expect(body).toContain('set({ apports: cached, loading: false, error: null });');
  });
});
