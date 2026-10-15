// Empty-state resolution gates (flagged by Sebastiao on video, 2026-10-14):
// switching tabs painted screens' empty states (« Aucun produit », « Aucun
// fournisseur », « Aucune dépense ») over the previous screen BEFORE the
// list had loaded — the state declared "confirmed empty" while the store
// only knew "not loaded yet". The cure already existed for products and
// sales (<x>FetchedFor markers); this fix extends it to every list store
// and gates every list screen's skeleton on it: skeleton until the load
// has RESOLVED for this business/user, empty state only on a confirmed
// zero. These contracts pin both halves per screen.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const count = (src: string, needle: string) => src.split(needle).length - 1;

const STORES: Record<string, string> = {
  fournisseurs: read('stores/fournisseurs.ts'),
  expenses: read('stores/expenses.ts'),
  apports: read('stores/apports.ts'),
  moderation: read('stores/moderation.ts'),
  equipe: read('stores/equipe.ts'),
  partnerships: read('stores/partnerships.ts'),
  market: read('stores/market.ts'),
};

describe('every list store carries a resolution marker set on terminal paths only', () => {
  it('fournisseursFetchedFor: declared, starts null, reset clears it, terminals set it', () => {
    const s = STORES.fournisseurs;
    expect(s).toContain('fournisseursFetchedFor: string | null');
    expect(s).toContain('fournisseursFetchedFor: null,');
    expect(s).toContain('fournisseursFetchedFor: null });');
    expect(count(s, 'fournisseursFetchedFor: businessId')).toBeGreaterThanOrEqual(4);
  });

  it('expensesFetchedFor: same lifecycle', () => {
    const s = STORES.expenses;
    expect(s).toContain('expensesFetchedFor: string | null');
    expect(s).toContain('expensesFetchedFor: null,');
    expect(count(s, 'expensesFetchedFor: businessId')).toBeGreaterThanOrEqual(4);
  });

  it('apportsFetchedFor: same lifecycle', () => {
    const s = STORES.apports;
    expect(s).toContain('apportsFetchedFor: string | null');
    expect(s).toContain('apportsFetchedFor: null,');
    expect(count(s, 'apportsFetchedFor: businessId')).toBeGreaterThanOrEqual(4);
  });

  it('partnerships partnersFetchedFor: same lifecycle', () => {
    const s = STORES.partnerships;
    expect(s).toContain('partnersFetchedFor: string | null');
    expect(count(s, 'partnersFetchedFor: businessId')).toBeGreaterThanOrEqual(4);
  });

  it('market postsFetchedFor (user-scoped): same lifecycle', () => {
    const s = STORES.market;
    expect(s).toContain('postsFetchedFor: string | null');
    expect(count(s, 'postsFetchedFor: userId')).toBeGreaterThanOrEqual(4);
  });

  it('moderation reportsFetched: boolean, false at start, true on terminals', () => {
    const s = STORES.moderation;
    expect(s).toContain('reportsFetched: boolean');
    expect(s).toContain('reportsFetched: false');
    expect(count(s, 'reportsFetched: true')).toBeGreaterThanOrEqual(3);
  });

  it('equipe codesFetched: fetchCodes sets it on both exits, reset clears it', () => {
    const s = STORES.equipe;
    expect(s).toContain('codesFetched: boolean');
    expect(count(s, 'codesFetched: true')).toBeGreaterThanOrEqual(2);
    expect(s).toContain('codesFetched: false');
  });
});

describe('every list screen holds its skeleton until the load resolves', () => {
  const gates: Array<[string, string]> = [
    ['app/(app)/(tabs)/vendre.tsx', '(loading || productsFetchedFor !== businessId) && products.length === 0'],
    ['app/(app)/clients/index.tsx', '(loading || salesFetchedFor !== businessId) && allClients.length === 0'],
    ['app/(app)/ventes/index.tsx', '(loading || salesFetchedFor !== businessId) && sales.length === 0'],
    ['app/(app)/fournisseurs/index.tsx', '(loading || fournisseursFetchedFor !== businessId) && fournisseurs.length === 0'],
    ['app/(app)/depenses/index.tsx', '(loading || expensesFetchedFor !== businessId) && isEmpty'],
    ['app/(app)/apports/index.tsx', '(loading || apportsFetchedFor !== businessId) && apports.length === 0'],
    ['app/(app)/moderation/index.tsx', '(loading || !reportsFetched) && reports.length === 0'],
    ['app/(app)/equipe/index.tsx', '(loading || !codesFetched) && codes.length === 0'],
    ['app/(app)/discussions.tsx', '(partnersLoading || partnersFetchedFor !== businessId) && partners.length === 0'],
    ['app/(app)/discussions.tsx', '(marketLoading || postsFetchedFor !== userId) && posts.length === 0'],
  ];

  it.each(gates)('%s gates on %s', (file, gate) => {
    expect(read(file)).toContain(gate);
  });
});
