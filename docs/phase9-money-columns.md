# Phase 9 — money column audit (Finding 2)

Production has `so_lines.unit_price` as `real` (float4); the migration chain says `bigint`
(schema.sql `numeric(15,2)`, then `migration_v24` `ROUND(x*100)::BIGINT`). This file lists
every money/quantity column in the **replayed** chain, the founder's production query, and
how `db/migration_v231.sql` treats drift.

## Why float4 is not acceptable for money

float4 has a 24-bit mantissa. Integers above 2^24 = 16,777,216 are not all representable
(spacing 2 up to 33.5M, 8 at ~134M, 16 at ~268M). `unit_price` is in **cents**, so any unit
price above **167,772.16** of the currency (≈167,772 GNF) may already have been rounded when
it was written, and `SUM(qty * unit_price)` over floats depends on summation order.
Conversion cannot restore a value that was rounded at write time; it can only stop further
damage, and the pre-flight below tells you whether any damage exists.

## Replay types (what the chain says production should be)

| Table | Column | Replay type | Meaning | v231 handles |
|---|---|---|---|---|
| alpha_audit_trail | cost | `numeric` | display-unit / rate | yes |
| alpha_messages | cost | `numeric` | display-unit / rate | yes |
| businesses | highest_revenue_milestone_cents | `bigint` | cents | yes |
| capital_injections | amount | `bigint` | cents | yes |
| expenses | amount | `bigint` | cents | yes |
| investor_balance | balance | `bigint` | cents | yes |
| investor_payouts | paid_amount | `bigint` | cents | yes |
| investor_payouts | requested_amount | `bigint` | cents | yes |
| investors | amount | `numeric(15,2)` | display-unit / rate | yes |
| investors | equity_pct | `numeric(5,2)` | display-unit / rate | yes |
| membership_product_scope | profit_share | `numeric(5,2)` | display-unit / rate | yes |
| payments | amount | `bigint` | cents | yes |
| po_lines | qty_ordered | `numeric(15,2)` | quantity | yes |
| po_lines | qty_received | `numeric(15,2)` | quantity | yes |
| po_lines | unit_cost | `numeric(15,2)` | display-unit / rate | yes |
| po_receipt_batch_lines | landed_cost_cents | `bigint` | cents | yes |
| po_receipt_batch_lines | qty_received | `integer` | quantity | n/a (integer is exact) |
| po_receipt_batches | shipping_cost_cents | `bigint` | cents | yes |
| product_variants | cost_price | `bigint` | cents | yes |
| product_variants | reorder_level | `numeric` | quantity | yes |
| product_variants | sale_price | `bigint` | cents | yes |
| product_variants | stock_qty | `numeric` | quantity | yes |
| products | bulk_min_qty | `integer` | integer count | n/a (integer is exact) |
| products | bulk_price | `bigint` | cents | yes |
| products | cost_price | `bigint` | cents | yes |
| products | reorder_level | `numeric(15,2)` | quantity | yes |
| products | sale_price | `bigint` | cents | yes |
| products | stock_qty | `numeric(15,2)` | quantity | yes |
| purchase_orders | total_cost | `numeric(15,2)` | display-unit / rate | yes |
| sale_orders | discount_amount | `bigint` | cents | yes |
| sale_orders | total_amount | `bigint` | cents | yes |
| so_lines | cost_price_at_sale | `bigint` | cents | yes |
| so_lines | qty | `numeric(15,2)` | quantity | yes |
| so_lines | unit_price | `bigint` | cents | yes |
| stock_moves | qty | `numeric(15,2)` | quantity | yes |
| supplier_debts | amount | `bigint` | cents | yes |
| supplier_debts | amount_paid | `bigint` | cents | yes |
| supplier_payments | amount_cents | `bigint` | cents | yes |
| so_lines | unit_price_paid | **not created by any migration** | cents (v104 reads it) | yes, if present |

Money is `bigint` cents everywhere except the pre-v24 display-unit tables (`po_lines.unit_cost`,
`purchase_orders.total_cost`, `investors.*`, `membership_product_scope.profit_share`), which are
`numeric(p,s)` — exact. No `real`, `double precision` or `money` column exists in the replay.
`alpha_*.cost` is unbounded `numeric` (AI spend in USD) — exact.

## Founder: run these on PRODUCTION (read-only)

**1. Every money-ish column and its type — send me the output, I reconcile it against the table above**

```sql
SELECT c.table_name, c.column_name, c.data_type, c.numeric_precision, c.numeric_scale
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
WHERE c.table_schema = 'public'
  AND (
        c.column_name ~* 'amount|price|cost|total|paid|debt|balance|cents|revenue|equity|profit|payout|discount|fee|value|stake|share|capital|owed|margin|qty|quantity|stock|reorder|cogs'
     OR c.data_type IN ('real', 'double precision', 'money')
      )
  AND c.data_type NOT IN ('text','uuid','boolean','date','jsonb','json','character varying','timestamp with time zone','timestamp without time zone')
ORDER BY c.table_name, c.column_name;
```

Anything typed `real`, `double precision` or `money` is drift. Anything in the table above whose
type differs from "Replay type" is drift too. Columns that are in production but **not** in my
table (like `so_lines.unit_price_paid`) are exactly what I need to see.

**2. Is there actual damage in `so_lines.unit_price`? (read-only)**

```sql
SELECT
  count(*)                                                                              AS lines,
  count(*) FILTER (WHERE unit_price::double precision <> trunc(unit_price::double precision)) AS fractional_values,
  count(*) FILTER (WHERE unit_price::double precision >  16777216)                        AS above_2_24,
  max(unit_price::double precision)                                                       AS max_unit_price
FROM so_lines;
```

`fractional_values > 0` means the column holds display units or damaged data: **v231 will refuse
to run** (by design) and you should send me the output instead of forcing it.
`above_2_24 > 0` means those lines were exposed to float rounding; check them with query 3.

**3. Orders whose header total no longer equals the sum of their lines (the damage detector)**

```sql
SELECT so.id, so.business_id, so.sale_date, so.total_amount,
       l.line_total, so.total_amount - l.line_total AS diff
FROM sale_orders so
JOIN (SELECT order_id, SUM(qty * unit_price::double precision) AS line_total
      FROM so_lines GROUP BY order_id) l ON l.order_id = so.id
WHERE so.status IN ('paye','credit')
  AND abs(so.total_amount - l.line_total) >= 1
ORDER BY abs(so.total_amount - l.line_total) DESC
LIMIT 50;
```

(`submit_sale` derives the header from the cart since v190, so a non-zero diff on an order is
float damage, a sale edit, or a line priced via `unit_price_paid`. Reconciliation check #9 already
tests the same thing nightly with `COALESCE(unit_price_paid, unit_price)`.)

## What `migration_v231.sql` does on production

* Column already exact -> untouched. Real/double cents column with whole-cent values -> `bigint`
  via the exact double value (no rounding possible). Fractional / NaN / out-of-range -> **RAISE**,
  nothing applied (one atomic `DO` block).
* float display-unit columns -> `numeric(p,s)` via the shortest decimal text (`12.34`, not
  `12.3400001525879`); more decimals than the scale -> **RAISE**.
* A view or policy on a drifted column makes Postgres refuse the type change; the migration aborts
  naming the column.
* Any other `real`/`double precision` column in `public` that looks like money aborts the migration
  (unknown drift must surface). Non-money-looking float columns only log a NOTICE.
* On the replayed schema it is a no-op (proved by `phase9-money-types.integration.test.ts`).

Apply order: run the pre-flight, **then** `migration_v231.sql`, then `migration_v232.sql`/`v233.sql`.
