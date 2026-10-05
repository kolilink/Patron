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
--   migration_v104 reads it (qty * COALESCE(unit_price_paid, unit_price)), so
--   production has it. Skipped when the column does not exist.
--   After the conversions, any REMAINING real/double column in schema public
--   whose name looks like money/quantity raises (an unknown drifted column must
--   surface, not be skipped); other float columns only produce a NOTICE.
--
-- WHAT THIS CANNOT DO: restore a value float4 already rounded when it was
-- written. See docs/phase9-money-columns.md for the production pre-flight
-- (non-integral rows, rows above 2^24, and per-order line-vs-header mismatches
-- that would reveal actual damage). Run it BEFORE applying this migration.
--
-- Dependent views/policies: ALTER COLUMN TYPE is refused by Postgres for a
-- column used in a view or policy. If production has one on a drifted column the
-- migration aborts (nothing applied) with a message naming the column.

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
BEGIN
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
END $$;
