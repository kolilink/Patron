// Populates ONE ROW IN EVERY TABLE of a business's ON DELETE CASCADE tree, driven by
// the catalog (pg_constraint), not by a hand-written list — so a table added by a
// future migration is picked up automatically, and if it can't be filled the test
// that uses this fails loudly instead of silently under-covering the delete.
//
// LOCAL TEST DATABASE ONLY. Runs on one pg Client, inside the caller's transaction.
import { randomUUID } from 'crypto';
import type { Client } from 'pg';

const TREE_SQL = `
WITH RECURSIVE fk AS (
  SELECT c.conrelid child, c.confrelid parent, c.confdeltype act
  FROM pg_constraint c WHERE c.contype='f' AND c.connamespace='public'::regnamespace),
d(tbl) AS (
  SELECT 'public.businesses'::regclass
  UNION SELECT fk.child FROM fk JOIN d ON fk.parent = d.tbl WHERE fk.act = 'c')
SELECT tbl::oid AS oid, tbl::text AS name FROM d`;

export interface FillReport {
  /** table -> primary key of the row inserted for this business */
  rows: Record<string, unknown>;
  /** every table in the cascade tree except businesses itself */
  tables: string[];
  /** tables the filler could not populate, with the reason (must be empty) */
  failed: Array<[string, string]>;
}

export async function fillBusinessTree(
  c: Client,
  o: { businessId: string; ownerId: string },
): Promise<FillReport> {
  const tree = (await c.query(TREE_SQL)).rows as Array<{ oid: number; name: string }>;
  const treeOids = new Set(tree.map(t => t.oid));
  const byOid: Record<string, string> = Object.fromEntries(tree.map(t => [t.oid, t.name.replace(/^public\./, '')]));

  const fks = ((await c.query(`
    SELECT c.conrelid::oid AS child, c.confrelid::oid AS parent, c.confdeltype AS act,
           (SELECT a.attname FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attnum=c.conkey[1]) AS col,
           c.confrelid::regclass::text AS pname, array_length(c.conkey,1) AS n
    FROM pg_constraint c WHERE c.contype='f' AND c.connamespace='public'::regnamespace`)).rows as any[])
    .filter(f => treeOids.has(f.child) && f.n === 1);

  const tables = tree.map(t => t.name.replace(/^public\./, '')).filter(n => n !== 'businesses');
  const deps: Record<string, Set<string>> = {};
  for (const t of tree) {
    deps[byOid[t.oid]] = new Set(
      fks.filter(f => f.child === t.oid && treeOids.has(f.parent) && f.parent !== t.oid).map(f => byOid[f.parent]),
    );
  }
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string) => { if (seen.has(n)) return; seen.add(n); for (const d of deps[n] ?? []) visit(d); order.push(n); };
  tables.forEach(visit);

  const rows: Record<string, unknown> = { businesses: o.businessId };
  const failed: Array<[string, string]> = [];

  const pkOf = async (t: string): Promise<string> => ((await c.query(
    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
      WHERE i.indrelid=$1::regclass AND i.indisprimary`, ['public.' + t])).rows[0]?.attname ?? 'id');

  for (const t of order) {
    if (t === 'businesses') continue;
    const cols = (await c.query(`
      SELECT column_name, data_type, udt_name, is_nullable, column_default, is_generated, is_identity
      FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t])).rows;
    const myFks = fks.filter(f => byOid[f.child] === t);
    const fkOf: Record<string, any> = Object.fromEntries(myFks.map(f => [f.col, f]));

    // CHECK (col = ANY (ARRAY['a','b'])) -> first allowed value
    const allowed: Record<string, string[]> = {};
    const checks = (await c.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid=$1::regclass AND contype='c'`, ['public.' + t])).rows;
    for (const { d } of checks) {
      const m = d.match(/\(?\(?(\w+)\)?(?:::text)?\s*=\s*ANY\s*\(\(?ARRAY\[(.*?)\]/s);
      if (m) allowed[m[1]] = [...m[2].matchAll(/'([^']*)'/g)].map((x: RegExpMatchArray) => x[1]);
    }

    const names: string[] = [];
    const vals: unknown[] = [];
    let skip: string | null = null;
    for (const col of cols) {
      if (col.is_generated === 'ALWAYS' || col.is_identity === 'YES') continue;
      const fk = fkOf[col.column_name];
      const needs = col.is_nullable === 'NO' && col.column_default === null;
      const cascadesToTree = fk && fk.act === 'c' && treeOids.has(fk.parent);
      if (!needs && !cascadesToTree) continue;
      let v: unknown;
      if (fk) {
        const pn = String(fk.pname).replace(/^public\./, '');
        if (pn === 'businesses') v = o.businessId;
        else if (pn === 'profiles' || pn === 'auth.users') v = o.ownerId;
        else if (pn === t) { if (!needs) continue; v = null; }
        else v = rows[pn];
        if (v === undefined) { skip = `parent ${pn} has no row`; break; }
      } else if (allowed[col.column_name]) {
        v = allowed[col.column_name][0];
      } else {
        switch (col.data_type) {
          case 'uuid': v = randomUUID(); break;
          case 'text': case 'character varying': v = 'x'; break;
          case 'integer': case 'bigint': case 'numeric': case 'smallint': case 'double precision': case 'real': v = 1; break;
          case 'boolean': v = false; break;
          case 'timestamp with time zone': case 'timestamp without time zone': case 'date': v = new Date(); break;
          case 'jsonb': case 'json': v = '{}'; break;
          case 'ARRAY': v = '{}'; break;
          case 'USER-DEFINED': {
            const e = (await c.query(`SELECT e.enumlabel FROM pg_enum e JOIN pg_type ty ON ty.oid=e.enumtypid WHERE ty.typname=$1 ORDER BY e.enumsortorder LIMIT 1`, [col.udt_name])).rows[0];
            v = e?.enumlabel; break;
          }
          default: v = null;
        }
      }
      names.push(col.column_name); vals.push(v);
    }
    if (skip) { failed.push([t, skip]); continue; }
    if (names.length === 0) { failed.push([t, 'no insertable columns']); continue; }

    await c.query('SAVEPOINT fill');
    try {
      const r = await c.query(
        `INSERT INTO ${t} (${names.map(x => `"${x}"`).join(',')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals);
      await c.query('RELEASE SAVEPOINT fill');
      const pk = await pkOf(t);
      rows[t] = r.rows[0][pk] ?? r.rows[0].id ?? null;
    } catch (e: any) {
      await c.query('ROLLBACK TO SAVEPOINT fill');
      if (e.code === '23505') {
        // A trigger already created this table's row for the business (memberships, business_data_versions…).
        const bizFk = myFks.find(f => String(f.pname) === 'businesses' || f.pname === 'public.businesses');
        const pk = await pkOf(t);
        const col = bizFk?.col ?? 'business_id';
        const got = (await c.query(`SELECT "${pk}" AS pk FROM ${t} WHERE "${col}" = $1 LIMIT 1`, [o.businessId])).rows[0];
        if (got) rows[t] = got.pk; else failed.push([t, `unique violation but no row found via ${col}`]);
      } else {
        failed.push([t, `${e.code} ${String(e.message).slice(0, 120)}`]);
      }
    }
  }

  // Exercise the NO ACTION references the purge has to resolve by hand: a real
  // product<->supplier link, and variant references on stock / PO / sale lines.
  const link = async (child: string, col: string, parent: string) => {
    if (rows[child] == null || rows[parent] == null) return;
    const pk = await pkOf(child);
    await c.query(`UPDATE ${child} SET "${col}" = $1 WHERE "${pk}" = $2`, [rows[parent], rows[child]]);
  };
  await link('products', 'supplier_id', 'suppliers');
  await link('stock_moves', 'variant_id', 'product_variants');
  await link('po_lines', 'variant_id', 'product_variants');
  await link('so_lines', 'variant_id', 'product_variants');

  return { rows, tables, failed };
}
