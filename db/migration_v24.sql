-- migration_v24: Store all monetary amounts as integer cents (×100)
-- Eliminates floating-point precision errors for all currencies.
-- Convention: 1500 GNF is stored as 150000. Divide by 100 to display.
-- Since there is no production data, the USING clause converts existing zeros safely.

ALTER TABLE products
  ALTER COLUMN cost_price  TYPE BIGINT USING ROUND(cost_price  * 100)::BIGINT,
  ALTER COLUMN sale_price  TYPE BIGINT USING ROUND(sale_price  * 100)::BIGINT,
  ALTER COLUMN bulk_price  TYPE BIGINT USING ROUND(COALESCE(bulk_price, 0) * 100)::BIGINT;

ALTER TABLE sale_orders
  ALTER COLUMN total_amount    TYPE BIGINT USING ROUND(total_amount    * 100)::BIGINT,
  ALTER COLUMN discount_amount TYPE BIGINT USING ROUND(discount_amount * 100)::BIGINT;

ALTER TABLE so_lines
  ALTER COLUMN unit_price TYPE BIGINT USING ROUND(unit_price * 100)::BIGINT;

ALTER TABLE payments
  ALTER COLUMN amount TYPE BIGINT USING ROUND(amount * 100)::BIGINT;

ALTER TABLE expenses
  ALTER COLUMN amount TYPE BIGINT USING ROUND(amount * 100)::BIGINT;
