// Phase 9, Finding 4 — report RPCs vs roles. LOCAL TEST DB ONLY (pg-role harness).
//
// SECURITY DEFINER report functions bypass RLS, so the role boundary the app
// draws in the UI (vendeur = own sales only; whole-business financials for
// administrateur/manager, and — by the app's own design — investisseur) has to
// be enforced INSIDE each function. These tests call every RPC directly as
// each role, the way a modified client would.
import { as, tryAs, seedUser, seedBusiness, seedMember, seedProduct, seedSale, user, ANON, SERVICE } from './pgrole';
import { assertLocalDb, q } from './pg';

beforeAll(() => assertLocalDb());

const REFUSED = { code: 'P0001', message: expect.stringMatching(/Accès refusé/) };
const DENIED = { code: '42501', message: expect.stringMatching(/permission denied for function/) };

const ADMIN_SALE = 100000;    // cents, 2 units  -> 200000
const VENDEUR_SALE = 50000;   // cents, 1 unit   ->  50000
const today = new Date().toISOString().slice(0, 10);
const monthStart = today.slice(0, 8) + '01';

let admin: string, manager: string, vendeurA: string, vendeurB: string, investor: string, outsider: string;
let biz: string, prod: string;

beforeAll(async () => {
  admin = await seedUser('admin');
  manager = await seedUser('manager');
  vendeurA = await seedUser('vendeurA');
  vendeurB = await seedUser('vendeurB');
  investor = await seedUser('investor');
  outsider = await seedUser('outsider');
  biz = await seedBusiness(admin, 'Commerce Phase9');
  await seedMember(biz, manager, 'manager');
  await seedMember(biz, vendeurA, 'vendeur');
  await seedMember(biz, vendeurB, 'vendeur');
  await seedMember(biz, investor, 'investisseur');
  await seedBusiness(outsider, 'Autre commerce');
  prod = await seedProduct(biz, admin, { name: 'Riz' });
  await seedSale(biz, admin, prod, 2, ADMIN_SALE);
  await seedSale(biz, vendeurA, prod, 1, VENDEUR_SALE);
});

const bestSellers = (who: any) =>
  tryAs(who, 'SELECT * FROM get_best_sellers($1, $2, 5)', [biz, monthStart]);

describe('get_best_sellers', () => {
  it('administrateur and manager see business-wide revenue', async () => {
    for (const who of [admin, manager]) {
      const r = await bestSellers(user(who));
      expect(r.error).toBeUndefined();
      expect(Number(r.rows![0].total_revenue)).toBe(2 * ADMIN_SALE + VENDEUR_SALE);
    }
  });

  it('vendeur sees ONLY their own sales — never the business-wide figure', async () => {
    const a = await bestSellers(user(vendeurA));
    expect(a.error).toBeUndefined();
    expect(a.rows).toHaveLength(1);
    expect(Number(a.rows![0].total_revenue)).toBe(VENDEUR_SALE);
    expect(Number(a.rows![0].total_qty)).toBe(1);
    const b = await bestSellers(user(vendeurB)); // never sold anything
    expect(b.error).toBeUndefined();
    expect(b.rows).toEqual([]);
  });

  it('investisseur keeps the whole-business ranking (app design: investor dashboard computes stake gains from it)', async () => {
    const r = await bestSellers(user(investor));
    expect(r.error).toBeUndefined();
    expect(Number(r.rows![0].total_revenue)).toBe(2 * ADMIN_SALE + VENDEUR_SALE);
  });

  it('a non-member is refused; anon has no EXECUTE', async () => {
    expect((await bestSellers(user(outsider))).error).toMatchObject(REFUSED);
    expect((await bestSellers(ANON)).error).toMatchObject(DENIED);
  });

  it('get_best_sellers_unchecked: EXECUTE still revoked from anon AND authenticated (service_role only)', async () => {
    const acl = await q(`SELECT has_function_privilege('anon', oid, 'EXECUTE') AS anon,
                                has_function_privilege('authenticated', oid, 'EXECUTE') AS auth,
                                has_function_privilege('service_role', oid, 'EXECUTE') AS svc
                         FROM pg_proc WHERE proname = 'get_best_sellers_unchecked'`);
    expect(acl).toEqual([{ anon: false, auth: false, svc: true }]);
    for (const who of [ANON, user(vendeurA), user(admin)]) {
      const r = await tryAs(who, 'SELECT * FROM get_best_sellers_unchecked($1, $2, 5)', [biz, monthStart]);
      expect(r.error).toMatchObject(DENIED);
    }
  });
});

describe('get_order_cogs (business-wide cost of goods — admin/manager only)', () => {
  const call = (who: any) => tryAs(who, 'SELECT * FROM get_order_cogs($1, $2)', [biz, monthStart]);

  it('administrateur and manager get COGS', async () => {
    for (const who of [admin, manager]) {
      const r = await call(user(who));
      expect(r.error).toBeUndefined();
      expect(r.rows!.length).toBe(2);
    }
  });

  it('vendeur and investisseur are refused (cost data is not theirs)', async () => {
    for (const who of [vendeurA, investor]) expect((await call(user(who))).error).toMatchObject(REFUSED);
  });

  it('non-member refused, anon denied, *_unchecked still service_role only', async () => {
    expect((await call(user(outsider))).error).toMatchObject(REFUSED);
    expect((await call(ANON)).error).toMatchObject(DENIED);
    const acl = await q(`SELECT has_function_privilege('anon', oid, 'EXECUTE') AS anon,
                                has_function_privilege('authenticated', oid, 'EXECUTE') AS auth
                         FROM pg_proc WHERE proname = 'get_order_cogs_unchecked'`);
    expect(acl).toEqual([{ anon: false, auth: false }]);
  });
});

describe('get_reports_snapshot / get_period_report — role derived server-side', () => {
  const snap = (who: any, claimedRole = 'administrateur', uid: string | null = null) =>
    tryAs(who, 'SELECT get_reports_snapshot($1, 30, $2, $3, $4) AS r', [biz, claimedRole, uid, today]);
  const period = (who: any, claimedRole = 'administrateur', uid: string | null = null) =>
    tryAs(who, 'SELECT get_period_report($1, $2, $3, $4, $5) AS r', [biz, monthStart, today, claimedRole, uid]);

  // Per-function field names: the two RPCs return different shapes.
  const cases = [
    {
      name: 'get_reports_snapshot', call: snap,
      adminCheck: (d: any) => expect(Number(d.revenue)).toBe(2 * ADMIN_SALE + VENDEUR_SALE),
      vendeurEmpty: ['revenue', 'cogs', 'gross_profit', 'net_profit', 'operating_expenses', 'credit_outstanding', 'cash_on_hand', 'stock_value', 'total_apports'],
      vendeurOwn: (d: any) => expect(Number(d.my_revenue)).toBe(VENDEUR_SALE),
      vendeurLists: ['top_sellers', 'activity'],
    },
    {
      name: 'get_period_report', call: period,
      adminCheck: (d: any) => { expect(Number(d.sales_count)).toBe(2); expect(Number(d.units_sold)).toBe(3); expect(Number(d.cash_on_hand)).toBe(2 * ADMIN_SALE + VENDEUR_SALE); },
      vendeurEmpty: ['sales_count', 'units_sold', 'net_profit', 'credit_outstanding', 'cash_on_hand'],
      vendeurOwn: (d: any) => { expect(Number(d.my_sales_count)).toBe(1); expect(Number(d.my_units_sold)).toBe(1); },
      vendeurLists: ['daily'],
    },
  ];

  for (const c of cases) {
    it(`${c.name}: admin sees the whole business`, async () => {
      const r = await c.call(user(admin));
      expect(r.error).toBeUndefined();
      expect(r.rows![0].r.role).toBe('administrateur');
      c.adminCheck(r.rows![0].r);
    });

    it(`${c.name}: a vendeur claiming administrateur still gets ONLY personal figures`, async () => {
      const r = await c.call(user(vendeurA), 'administrateur', admin);
      expect(r.error).toBeUndefined();
      const d = r.rows![0].r;
      expect(d.role).toBe('vendeur');
      for (const k of c.vendeurEmpty) expect(Number(d[k] ?? 0)).toBe(0);
      for (const k of c.vendeurLists) expect(d[k] ?? []).toEqual([]);
      c.vendeurOwn(d);
    });

    it(`${c.name}: non-member refused, anon has no EXECUTE`, async () => {
      expect((await c.call(user(outsider))).error).toMatchObject(REFUSED);
      expect((await c.call(ANON)).error).toMatchObject(DENIED);
    });
  }
});

describe('get_dashboard_kpis — Accueil numbers', () => {
  const kpis = (who: any) => tryAs(who, 'SELECT get_dashboard_kpis($1, $2) AS r', [biz, today]);

  it('admin/manager: business-wide', async () => {
    for (const who of [admin, manager]) {
      const r = await kpis(user(who));
      expect(r.error).toBeUndefined();
      expect(Number(r.rows![0].r.revenue_month)).toBe(2 * ADMIN_SALE + VENDEUR_SALE);
      expect(Number(r.rows![0].r.sales_today)).toBe(2);
    }
  });

  it('vendeur: own sales only (revenue and count), never the business total', async () => {
    const r = await kpis(user(vendeurA));
    expect(r.error).toBeUndefined();
    expect(Number(r.rows![0].r.revenue_month)).toBe(VENDEUR_SALE);
    expect(Number(r.rows![0].r.revenue_today)).toBe(VENDEUR_SALE);
    expect(Number(r.rows![0].r.sales_today)).toBe(1);
    const b = await kpis(user(vendeurB));
    expect(Number(b.rows![0].r.revenue_month)).toBe(0);
    expect(Number(b.rows![0].r.sales_today)).toBe(0);
  });

  it('non-member refused; anon refused', async () => {
    expect((await kpis(user(outsider))).error).toMatchObject(REFUSED);
    expect((await kpis(ANON)).error).toBeDefined();
  });
});

describe('get_product_stats — returns capital (qty × cost): a vendeur may not read costs (v193)', () => {
  const stats = (who: any) => tryAs(who, 'SELECT get_product_stats($1, $2, NULL) AS r', [prod, biz]);

  it('admin gets stats; vendeur is refused; non-member refused', async () => {
    const a = await stats(user(admin));
    expect(a.error).toBeUndefined();
    expect(Number(a.rows![0].r.capital)).toBeGreaterThan(0);
    expect((await stats(user(vendeurA))).error).toMatchObject(REFUSED);
    expect((await stats(user(outsider))).error).toMatchObject(REFUSED);
  });
});

describe('service_role path keeps working (reconciliation, cron)', () => {
  it('service_role can call the wrapped functions', async () => {
    const r = await tryAs(SERVICE, 'SELECT * FROM get_best_sellers_unchecked($1, $2, 5)', [biz, monthStart]);
    expect(r.error).toBeUndefined();
    expect(r.rows!.length).toBe(1);
  });
});
