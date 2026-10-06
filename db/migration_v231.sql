-- migration_v231 — Phase 9, Finding 2: money is never float.
--
-- FINDING. Production's so_lines.unit_price is `real` (float4) while the migration
-- chain (schema.sql numeric(15,2), then migration_v24's ROUND(x*100)::BIGINT)
-- says bigint. A float4 has a 24-bit mantissa: integers above 2^24 = 16,777,216
-- are NOT all representable (spacing 2 up to 33.5M, 8 at 134M, 16 at 268M).
-- A unit price is stored in cents, so any unit price above 167,772.16 of the
-- currency (167,772 GNF!) can already have been rounded at write time, and
-- SUM(qty * unit_price) over float is order-dependent. Money must be exact.
--
-- WHAT THIS DOES (idempotent, one atomic DO block — it either converts
-- everything it must or changes nothing):
--   For every money / quantity column in the chain, read its CURRENT type:
--     * already exact (bigint for cents, numeric for display-unit money and
--       quantities) -> untouched. On the replayed schema this is every column,
--       so on a clean replay the migration is a no-op.
--     * smallint/integer cents -> widened to bigint (lossless).
--     * float (real / double precision) or numeric cents -> converted to bigint,
--       but ONLY after checking every row is a whole number of cents. A
--       fractional value means the column holds display units (or already-
--       damaged data) and the scale is unknowable here, so the migration RAISES
--       with the table.column and the row count instead of rounding. Conversion
--       goes through double precision (the exact binary value that was stored),
--       never through float4 -> numeric (which keeps only 6 significant digits:
--       1234567.875::real::numeric = 1234570).
--     * float display-unit money/quantity columns -> numeric(p,s) via the
--       column's shortest round-trip decimal text (what the app wrote, e.g.
--       12.34, not 12.3400001525879); RAISES if that text has more decimals
--       than the target scale (so nothing is rounded silently).
--   so_lines.unit_price_paid is listed even though NO migration creates it:
--   migration_v104 reads it (qty * COALESCE(unit_price_paid, unit_price)), but
--   the production pre-flight (2026-10-05) showed it does NOT exist there.
--   Kept as a harmless guard: skipped when the column does not exist.
--   After the conversions, any REMAINING real/double column in schema public
--   whose name looks like money/quantity raises (an unknown drifted column must
--   surface, not be skipped); other float columns only produce a NOTICE.
--
-- WHAT THIS CANNOT DO: restore a value float4 already rounded when it was
-- written. See docs/phase9-money-columns.md for the production pre-flight
-- (non-integral rows, rows above 2^24, and per-order line-vs-header mismatches
-- that would reveal actual damage). Run it BEFORE applying this migration.
--
-- Dependent views: ALTER COLUMN TYPE is refused by Postgres for a column used in
-- a view (production: payments.amount is read by kpi_core_actions, which
-- kpi_business_activity reads in turn). The migration therefore saves every view
-- (transitively) depending on a column it is about to convert — definition,
-- owner, ACL, reloptions — drops them dependents-first, converts, then recreates
-- them dependencies-first and restores owner/ACL, all inside the same atomic
-- block. Policies on a drifted column still abort with a message naming it.

DO $$
DECLARE
  spec     record;
  v_type   text;
  v_prec   int;
  v_scale  int;
  v_bad    bigint;
  v_expr   text;
  v_digits int;
  rec      record;
  vw       record;
BEGIN
  DROP TABLE IF EXISTS _v231_views;
  -- Save + drop views that depend (transitively) on a column still to convert.
  CREATE TEMP TABLE _v231_views ON COMMIT DROP AS
  WITH RECURSIVE targets(tbl, col) AS (
    SELECT * FROM (VALUES
      ('products','cost_price'),('products','sale_price'),('products','bulk_price'),
      ('product_variants','cost_price'),('product_variants','sale_price'),
      ('sale_orders','total_amount'),('sale_orders','discount_amount'),
      ('so_lines','unit_price'),('so_lines','unit_price_paid'),('so_lines','cost_price_at_sale'),
      ('payments','amount'),('expenses','amount'),
      ('supplier_debts','amount'),('supplier_debts','amount_paid'),('supplier_payments','amount_cents'),
      ('capital_injections','amount'),('investor_balance','balance'),
      ('investor_payouts','requested_amount'),('investor_payouts','paid_amount'),
      ('po_receipt_batches','shipping_cost_cents'),('po_receipt_batch_lines','landed_cost_cents'),
      ('businesses','highest_revenue_milestone_cents'),
      ('po_lines','unit_cost'),('purchase_orders','total_cost'),('investors','amount'),
      ('investors','equity_pct'),('membership_product_scope','profit_share'),
      ('alpha_messages','cost'),('alpha_audit_trail','cost'),
      ('so_lines','qty'),('stock_moves','qty'),('po_lines','qty_ordered'),('po_lines','qty_received'),
      ('products','stock_qty'),('products','reorder_level'),
      ('product_variants','stock_qty'),('product_variants','reorder_level')
    ) v(tbl, col)
  ),
  need AS (  -- columns whose current type is not already the exact target
    SELECT cl.oid AS relid, a.attnum
    FROM targets t
    JOIN pg_class cl ON cl.relname = t.tbl AND cl.relnamespace = 'public'::regnamespace AND cl.relkind = 'r'
    JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attname = t.col AND NOT a.attisdropped
    WHERE a.atttypid IN ('real'::regtype, 'double precision'::regtype, 'smallint'::regtype, 'integer'::regtype)
  ),
  deps(view_oid, depth) AS (
    SELECT DISTINCT rw.ev_class, 1
    FROM need n
    JOIN pg_depend d ON d.refobjid = n.relid AND d.refobjsubid = n.attnum AND d.classid = 'pg_rewrite'::regclass
    JOIN pg_rewrite rw ON rw.oid = d.objid
    JOIN pg_class v ON v.oid = rw.ev_class AND v.relkind = 'v' AND v.oid <> n.relid
    UNION
    SELECT rw.ev_class, deps.depth + 1
    FROM deps
    JOIN pg_depend d ON d.refobjid = deps.view_oid AND d.classid = 'pg_rewrite'::regclass
    JOIN pg_rewrite rw ON rw.oid = d.objid
    JOIN pg_class v ON v.oid = rw.ev_class AND v.relkind = 'v' AND v.oid <> deps.view_oid
  )
  SELECT c.oid AS oid, c.relnamespace::regnamespace::text AS sch, c.relname::text AS name,
         max(deps.depth) AS depth,
         pg_get_viewdef(c.oid, true) AS def,
         pg_get_userbyid(c.relowner)::text AS owner,
         c.relacl::text AS acl, c.reloptions
  FROM deps JOIN pg_class c ON c.oid = deps.view_oid
  GROUP BY c.oid, c.relnamespace, c.relname, c.relowner, c.relacl, c.reloptions;

  FOR vw IN SELECT * FROM _v231_views ORDER BY depth DESC LOOP
    EXECUTE format('DROP VIEW %I.%I', vw.sch, vw.name);
    RAISE NOTICE 'migration_v231: dropped dependent view %.% (recreated at the end)', vw.sch, vw.name;
  END LOOP;

  -- shortest round-trip text for floats (PG >= 12 default; pin it anyway)
  PERFORM set_config('extra_float_digits', '1', true);

  FOR spec IN
    SELECT * FROM (VALUES
      -- ── cents (BIGINT, v24) ────────────────────────────────────────────
      ('products',               'cost_price',                'cents',   NULL::text),
      ('products',               'sale_price',                'cents',   NULL),
      ('products',               'bulk_price',                'cents',   NULL),
      ('product_variants',       'cost_price',                'cents',   NULL),
      ('product_variants',       'sale_price',                'cents',   NULL),
      ('sale_orders',            'total_amount',              'cents',   NULL),
      ('sale_orders',            'discount_amount',           'cents',   NULL),
      ('so_lines',               'unit_price',                'cents',   NULL),
      ('so_lines',               'unit_price_paid',           'cents',   NULL),  -- production-only (v104)
      ('so_lines',               'cost_price_at_sale',        'cents',   NULL),
      ('payments',               'amount',                    'cents',   NULL),
      ('expenses',               'amount',                    'cents',   NULL),
      ('supplier_debts',         'amount',                    'cents',   NULL),
      ('supplier_debts',         'amount_paid',               'cents',   NULL),
      ('supplier_payments',      'amount_cents',              'cents',   NULL),
      ('capital_injections',     'amount',                    'cents',   NULL),
      ('investor_balance',       'balance',                   'cents',   NULL),
      ('investor_payouts',       'requested_amount',          'cents',   NULL),
      ('investor_payouts',       'paid_amount',               'cents',   NULL),
      ('po_receipt_batches',     'shipping_cost_cents',       'cents',   NULL),
      ('po_receipt_batch_lines', 'landed_cost_cents',         'cents',   NULL),
      ('businesses',             'highest_revenue_milestone_cents', 'cents', NULL),
      -- ── display-unit money (pre-v24 tables v24 never converted) ────────
      ('po_lines',               'unit_cost',                 'numeric', 'numeric(15,2)'),
      ('purchase_orders',        'total_cost',                'numeric', 'numeric(15,2)'),
      ('investors',              'amount',                    'numeric', 'numeric(15,2)'),
      ('investors',              'equity_pct',                'numeric', 'numeric(5,2)'),
      ('membership_product_scope','profit_share',             'numeric', 'numeric(5,2)'),
      ('alpha_messages',         'cost',                      'numeric', 'numeric'),
      ('alpha_audit_trail',      'cost',                      'numeric', 'numeric'),
      -- ── quantities ─────────────────────────────────────────────────────
      ('so_lines',               'qty',                       'numeric', 'numeric(15,2)'),
      ('stock_moves',            'qty',                       'numeric', 'numeric(15,2)'),
      ('po_lines',               'qty_ordered',               'numeric', 'numeric(15,2)'),
      ('po_lines',               'qty_received',              'numeric', 'numeric(15,2)'),
      ('products',               'stock_qty',                 'numeric', 'numeric(15,2)'),
      ('products',               'reorder_level',             'numeric', 'numeric(15,2)'),
      ('product_variants',       'stock_qty',                 'numeric', 'numeric'),
      ('product_variants',       'reorder_level',             'numeric', 'numeric')
    ) AS t(tbl, col, kind, target)
  LOOP
    SELECT c.data_type, c.numeric_precision, c.numeric_scale
      INTO v_type, v_prec, v_scale
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.table_name = spec.tbl AND c.column_name = spec.col;
    CONTINUE WHEN NOT FOUND;   -- column (or table) absent in this database

    IF spec.kind = 'cents' THEN
      CONTINUE WHEN v_type = 'bigint';

      IF v_type IN ('smallint', 'integer') THEN
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I TYPE bigint', spec.tbl, spec.col);
        RAISE NOTICE 'migration_v231: %.% % -> bigint (lossless widening)', spec.tbl, spec.col, v_type;
        CONTINUE;
      END IF;

      IF v_type NOT IN ('real', 'double precision', 'numeric') THEN
        RAISE EXCEPTION 'migration_v231: %.% has unexpected type % (expected bigint cents)', spec.tbl, spec.col, v_type;
      END IF;

      -- numeric compares as numeric; floats compare as their exact double value
      v_expr := CASE WHEN v_type = 'numeric' THEN format('%I', spec.col)
                     ELSE format('%I::double precision', spec.col) END;
      EXECUTE format(
        'SELECT count(*) FROM public.%I WHERE %I IS NOT NULL AND (NOT (%s BETWEEN -9.2e18 AND 9.2e18) OR %s <> trunc(%s))',
        spec.tbl, spec.col, v_expr, v_expr, v_expr) INTO v_bad;
      IF v_bad > 0 THEN
        RAISE EXCEPTION 'migration_v231: %.% (%) holds % row(s) that are not whole cents (fractional, NaN or out of range). Refusing to round silently — the column may hold display units or damaged values. Inspect: SELECT * FROM public.% WHERE % <> trunc(%)',
          spec.tbl, spec.col, v_type, v_bad, spec.tbl, spec.col, spec.col;
      END IF;

      BEGIN
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I TYPE bigint USING (%s)::bigint', spec.tbl, spec.col,
                       CASE WHEN v_type = 'numeric' THEN format('%I', spec.col) ELSE format('%I::double precision', spec.col) END);
      EXCEPTION WHEN feature_not_supported THEN
        RAISE EXCEPTION 'migration_v231: cannot convert %.% (%): a view or policy depends on it. Drop/recreate the dependent object, then re-run. (%)',
          spec.tbl, spec.col, v_type, SQLERRM;
      END;
      RAISE NOTICE 'migration_v231: %.% % -> bigint (every row verified whole cents)', spec.tbl, spec.col, v_type;

    ELSE  -- exact numeric (display-unit money, rates, quantities)
      CONTINUE WHEN v_type = 'numeric';

      IF v_type IN ('smallint', 'integer', 'bigint') THEN
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I TYPE %s USING %I::numeric', spec.tbl, spec.col, spec.target, spec.col);
        RAISE NOTICE 'migration_v231: %.% % -> % (lossless)', spec.tbl, spec.col, v_type, spec.target;
        CONTINUE;
      END IF;

      IF v_type NOT IN ('real', 'double precision') THEN
        RAISE EXCEPTION 'migration_v231: %.% has unexpected type % (expected %)', spec.tbl, spec.col, v_type, spec.target;
      END IF;

      -- no NaN / Infinity
      EXECUTE format('SELECT count(*) FROM public.%I WHERE %I IS NOT NULL AND %I::text IN (''NaN'',''Infinity'',''-Infinity'')',
                     spec.tbl, spec.col, spec.col) INTO v_bad;
      IF v_bad > 0 THEN
        RAISE EXCEPTION 'migration_v231: %.% holds % NaN/Infinity row(s); cannot convert to an exact type', spec.tbl, spec.col, v_bad;
      END IF;

      -- scale-limited target: the column's own shortest decimal text must fit it exactly
      v_digits := CASE WHEN spec.target ~ '\(\d+,(\d+)\)'
                       THEN (regexp_match(spec.target, '\(\d+,(\d+)\)'))[1]::int ELSE NULL END;
      IF v_digits IS NOT NULL THEN
        EXECUTE format('SELECT count(*) FROM public.%I WHERE %I IS NOT NULL AND (%I::text)::numeric <> round((%I::text)::numeric, %s)',
                       spec.tbl, spec.col, spec.col, spec.col, v_digits) INTO v_bad;
        IF v_bad > 0 THEN
          RAISE EXCEPTION 'migration_v231: %.% (%) holds % row(s) with more than % decimals; converting to % would round silently. Refusing.',
            spec.tbl, spec.col, v_type, v_bad, v_digits, spec.target;
        END IF;
      END IF;

      BEGIN
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I TYPE %s USING (%I::text)::numeric', spec.tbl, spec.col, spec.target, spec.col);
      EXCEPTION WHEN feature_not_supported THEN
        RAISE EXCEPTION 'migration_v231: cannot convert %.% (%): a view or policy depends on it. Drop/recreate the dependent object, then re-run. (%)',
          spec.tbl, spec.col, v_type, SQLERRM;
      END;
      RAISE NOTICE 'migration_v231: %.% % -> %', spec.tbl, spec.col, v_type, spec.target;
    END IF;
  END LOOP;

  -- Anything still float in schema public was not in the list above.
  FOR rec IN
    SELECT c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.data_type IN ('real', 'double precision')
    ORDER BY 1, 2
  LOOP
    IF rec.column_name ~* 'amount|price|cost|total|paid|debt|balance|cents|revenue|equity|profit|payout|discount|fee|value|stake|share|capital|owed|margin|salary|wage|due|sum|qty|quantity|stock' THEN
      RAISE EXCEPTION 'migration_v231: %.% is % and looks like money/quantity but is not in this migration''s list. Add it (with its scale) before applying.',
        rec.table_name, rec.column_name, rec.data_type;
    ELSE
      RAISE NOTICE 'migration_v231: float column %.% (%) left as-is (name does not look like money)', rec.table_name, rec.column_name, rec.data_type;
    END IF;
  END LOOP;

  -- Recreate the dropped views, dependencies first; restore owner, ACL, options.
  FOR vw IN SELECT * FROM _v231_views ORDER BY depth ASC LOOP
    EXECUTE format('CREATE VIEW %I.%I%s AS %s', vw.sch, vw.name,
      CASE WHEN vw.reloptions IS NULL THEN '' ELSE ' WITH (' || array_to_string(vw.reloptions, ', ') || ')' END,
      rtrim(vw.def, ';'));
    EXECUTE format('ALTER VIEW %I.%I OWNER TO %I', vw.sch, vw.name, vw.owner);
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC, anon, authenticated, service_role', vw.sch, vw.name);
    IF vw.acl IS NOT NULL THEN
      FOR rec IN
        SELECT x.grantee, x.privilege_type AS priv
        FROM aclexplode(vw.acl::aclitem[]) x
      LOOP
        IF rec.grantee <> 0 AND rec.grantee <> (SELECT oid FROM pg_roles WHERE rolname = vw.owner) THEN
          EXECUTE format('GRANT %s ON %I.%I TO %I', rec.priv, vw.sch, vw.name,
                         (SELECT rolname FROM pg_roles WHERE oid = rec.grantee));
        END IF;
      END LOOP;
    END IF;
    RAISE NOTICE 'migration_v231: recreated view %.%', vw.sch, vw.name;
  END LOOP;
END $$;
