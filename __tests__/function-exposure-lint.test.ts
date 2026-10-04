// Self-tests for the function-exposure lint (scripts/lib/function-exposure.js).
// The lint is the guard that makes "a public function with no auth check and
// no REVOKE ... FROM anon" impossible to merge — so the lint itself must be
// proven to catch each shape of the bug (and to accept each legitimate shape),
// against synthetic SQL, independent of what is currently in db/.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { findFunctionExposureViolations } = require('../scripts/lib/function-exposure');

function lint(files: Record<string, string>): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnexposure-'));
  try {
    for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
    return findFunctionExposureViolations(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SECDEF_NO_CHECK = (n: string) => `
CREATE OR REPLACE FUNCTION ${n}(p_business_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER AS $$ SELECT to_jsonb(b) FROM businesses b WHERE b.id = p_business_id $$;`;

describe('function-exposure lint', () => {
  it('flags a function with no auth check and no REVOKE', () => {
    const v = lint({ 'migration_v1.sql': SECDEF_NO_CHECK('leaky') });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/leaky\(uuid\)/);
  });

  it('REVOKE ... FROM PUBLIC alone does NOT close it (anon holds a direct grant)', () => {
    const v = lint({ 'migration_v1.sql': SECDEF_NO_CHECK('leaky') + '\nREVOKE ALL ON FUNCTION leaky(uuid) FROM PUBLIC;' });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/anon not revoked/);
  });

  it('REVOKE ... FROM anon alone does NOT close it either (the PUBLIC grant still reaches anon)', () => {
    // exactly how create_demo_business shipped (migration_v77)
    const v = lint({ 'migration_v1.sql': SECDEF_NO_CHECK('demo') + '\nREVOKE ALL ON FUNCTION demo(uuid) FROM anon, authenticated;' });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/PUBLIC not revoked/);
  });

  it('accepts PUBLIC and anon both revoked — in one statement or across two', () => {
    expect(lint({ 'migration_v1.sql': SECDEF_NO_CHECK('ok') + '\nREVOKE ALL ON FUNCTION public.ok(uuid) FROM PUBLIC, anon;' })).toEqual([]);
    expect(lint({ 'migration_v1.sql': SECDEF_NO_CHECK('ok2') + '\nREVOKE ALL ON FUNCTION ok2(uuid) FROM PUBLIC;\nREVOKE ALL ON FUNCTION ok2(uuid) FROM anon;' })).toEqual([]);
  });

  it('overloads are tracked separately: a safe overload must not hide a stale unguarded one', () => {
    // receive_purchase_order: guarded 2-arg + an old unguarded 3-arg, same name
    const guarded = `CREATE FUNCTION rpo(a uuid, b uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN IF NOT is_member(a) THEN RAISE EXCEPTION 'x'; END IF; END $$;`;
    const stale = `CREATE FUNCTION rpo(a uuid, b uuid, c uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN UPDATE t SET x = 1; END $$;`;
    const v = lint({ 'migration_v1.sql': guarded + '\n' + stale });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/rpo\(uuid,uuid,uuid\) /);
    // revoking just the 3-arg overload closes it
    expect(lint({ 'migration_v1.sql': guarded + '\n' + stale + '\nREVOKE ALL ON FUNCTION rpo(uuid, uuid, uuid) FROM PUBLIC, anon;' })).toEqual([]);
  });

  it('DROPping one overload does not erase a different overload with the same number of args', () => {
    // v36 defines rpo(uuid,uuid,uuid); v50 drops rpo(uuid,uuid,uuid[]) — the first must survive and still be flagged
    const a = `CREATE FUNCTION rpo(a uuid, b uuid, c uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;`;
    const v = lint({ 'migration_v1.sql': a, 'migration_v2.sql': 'DROP FUNCTION IF EXISTS rpo(uuid, uuid, uuid[]);' });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/rpo\(uuid,uuid,uuid\) /);
  });

  it('a later GRANT to PUBLIC re-opens a closed function', () => {
    const v = lint({
      'migration_v1.sql': SECDEF_NO_CHECK('flip2') + '\nREVOKE ALL ON FUNCTION flip2(uuid) FROM PUBLIC, anon;',
      'migration_v2.sql': 'GRANT EXECUTE ON FUNCTION flip2(uuid) TO PUBLIC;',
    });
    expect(v).toHaveLength(1);
  });

  it('accepts a body with an auth check', () => {
    const body = `CREATE FUNCTION guarded(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN IF NOT is_member(p) THEN RAISE EXCEPTION 'Accès refusé'; END IF; END $$;`;
    expect(lint({ 'migration_v1.sql': body })).toEqual([]);
  });

  it('an auth check that only appears in a COMMENT does not count', () => {
    const body = `CREATE FUNCTION fake(p uuid) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$
      -- TODO: add is_member(p) check here
      SELECT 1 $$;`;
    expect(lint({ 'migration_v1.sql': body })).toHaveLength(1);
  });

  it('a later GRANT to anon re-exposes a revoked function', () => {
    const v = lint({
      'migration_v1.sql': SECDEF_NO_CHECK('flip') + '\nREVOKE ALL ON FUNCTION flip(uuid) FROM PUBLIC, anon;',
      'migration_v2.sql': 'GRANT EXECUTE ON FUNCTION flip(uuid) TO anon;',
    });
    expect(v).toHaveLength(1);
  });

  it('CREATE OR REPLACE keeps the earlier REVOKE (grants are preserved)', () => {
    const v = lint({
      'migration_v1.sql': SECDEF_NO_CHECK('keep') + '\nREVOKE ALL ON FUNCTION keep(uuid) FROM PUBLIC, anon;',
      'migration_v2.sql': SECDEF_NO_CHECK('keep'),
    });
    expect(v).toEqual([]);
  });

  it('a replaced body that DROPS its auth check is caught (latest definition wins)', () => {
    const v = lint({
      'migration_v1.sql': `CREATE FUNCTION regress(p uuid) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 WHERE is_member(p) $$;`,
      'migration_v2.sql': SECDEF_NO_CHECK('regress'),
    });
    expect(v).toHaveLength(1);
  });

  it('ignores trigger functions (not callable as an RPC)', () => {
    const t = `CREATE FUNCTION set_x() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`;
    expect(lint({ 'migration_v1.sql': t })).toEqual([]);
  });

  it('orders migrations numerically (v10 comes after v9)', () => {
    const v = lint({
      'migration_v9.sql': SECDEF_NO_CHECK('ordered'),
      'migration_v10.sql': 'REVOKE ALL ON FUNCTION ordered(uuid) FROM PUBLIC, anon;',
    });
    expect(v).toEqual([]);
  });
});
