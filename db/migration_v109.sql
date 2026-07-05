-- ============================================================
-- Patron — Migration v109
-- Run in Supabase SQL Editor AFTER migration_v108
--
-- Adds missing indexes on business_id (and other FK columns used
-- in RLS policies / hot-path queries) across the core tables.
-- Postgres does not auto-index foreign key columns, only primary
-- keys and unique constraints — every is_member(business_id) RLS
-- check and every business-scoped screen query has been doing a
-- sequential scan. Pre-launch fix, zero behavior change.
-- ============================================================

create index if not exists idx_products_business_id      on products(business_id);
create index if not exists idx_stock_moves_business_id    on stock_moves(business_id);
create index if not exists idx_stock_moves_product_id     on stock_moves(product_id);
create index if not exists idx_sale_orders_business_id    on sale_orders(business_id);
create index if not exists idx_sale_orders_seller_id      on sale_orders(seller_id);
create index if not exists idx_so_lines_order_id          on so_lines(order_id);
create index if not exists idx_so_lines_product_id        on so_lines(product_id);
create index if not exists idx_expenses_business_id       on expenses(business_id);
create index if not exists idx_payments_created_at        on payments(created_at);
