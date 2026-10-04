// Backstop for the static function-exposure lint (scripts/lib/function-exposure.js):
// the same rule applied to the REAL post-replay pg_proc ACLs, which also catches
// anything the SQL text analysis cannot see (default privileges, dashboard-only
// edits replayed from schema.sql, ...). LOCAL TEST DB ONLY.
//
// Rule: a public function that anon can EXECUTE must have an auth check in its
// body (or be a trigger function, or be allowlisted with a reason).
import { assertLocalDb, q } from './pg';

const { AUTH_CHECK, EXPOSURE_ALLOWLIST, stripSqlComments } = require('../../scripts/lib/function-exposure');

beforeAll(() => assertLocalDb());

describe('live ACLs: no anon-callable function without an auth check', () => {
  it('every anon-executable public function authenticates its caller (or is a trigger / allowlisted)', async () => {
    const rows = await q(`
      SELECT p.proname, p.prosrc, p.prorettype::regtype::text AS ret
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.prokind = 'f'
        AND has_function_privilege('anon', p.oid, 'EXECUTE')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`);
    expect(rows.length).toBeGreaterThan(50); // sanity: we really scanned the schema
    const offenders = rows
      .filter((r: any) => r.ret !== 'trigger' && r.ret !== 'event_trigger')
      .filter((r: any) => !Object.prototype.hasOwnProperty.call(EXPOSURE_ALLOWLIST, r.proname))
      .filter((r: any) => !AUTH_CHECK.test(stripSqlComments(r.prosrc)))
      .map((r: any) => r.proname)
      .sort();
    expect(offenders).toEqual([]);
  });

  it('the v228 targets specifically are closed to anon (privilege layer, not just a body check)', async () => {
    const closed = ['get_financial_snapshot', 'get_best_sellers', 'get_order_cogs', 'run_reconciliation', 'run_variant_price_checks',
      'run_display_checks', 'run_supplier_payment_checks', 'refresh_reconciliation_run', 'get_int_setting', 'get_text_setting',
      'use_invite_code', 'upgrade_anonymous_user', 'get_reports_snapshot', 'get_period_report', 'create_demo_business',
      'get_best_sellers_unchecked', 'get_order_cogs_unchecked'];
    const rows = await q(`SELECT proname, has_function_privilege('anon', oid, 'EXECUTE') AS anon FROM pg_proc
                          WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1)`, [closed]);
    expect(rows.map((r: any) => r.proname).sort()).toEqual([...closed].sort());
    expect(rows.filter((r: any) => r.anon).map((r: any) => r.proname)).toEqual([]);
  });

  it('get_financial_snapshot and the reconciliation jobs are service_role-only (authenticated closed too)', async () => {
    const rows = await q(`SELECT proname, has_function_privilege('authenticated', oid, 'EXECUTE') AS auth, has_function_privilege('service_role', oid, 'EXECUTE') AS svc
                          FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN
                          ('get_financial_snapshot','run_reconciliation','run_variant_price_checks','run_display_checks','run_supplier_payment_checks',
                           'refresh_reconciliation_run','get_int_setting','get_text_setting','use_invite_code','create_demo_business',
                           'get_best_sellers_unchecked','get_order_cogs_unchecked')`);
    expect(rows).toHaveLength(12);
    for (const r of rows) expect([r.proname, r.auth, r.svc]).toEqual([r.proname, false, true]);
  });
});
