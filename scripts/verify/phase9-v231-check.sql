-- Read-only acceptance check for migration_v231 (Phase 9). Safe to run on production: SELECTs only.
select 'float_money_cols_left (expect 0)' as check_name, count(*)::text as result
from information_schema.columns
where table_schema = 'public' and data_type in ('real', 'double precision')
  and column_name ~* 'amount|price|cost|total|discount|qty|stock'
union all
select 'bigint_money_cols (expect 8)', count(*)::text
from information_schema.columns
where table_schema = 'public' and data_type = 'bigint' and (table_name, column_name) in
  (('payments','amount'),('expenses','amount'),('products','cost_price'),('products','sale_price'),
   ('products','bulk_price'),('sale_orders','total_amount'),('sale_orders','discount_amount'),('so_lines','unit_price'))
union all
select 'views_present (expect 5)', count(*)::text
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
  and c.relname in ('kpi_core_actions','kpi_business_activity','call_list_interview','call_list_referral','call_list_welcome')
union all
select 'view_acl: ' || c.relname, pg_get_userbyid(c.relowner) || ' ' || coalesce(c.relacl::text, 'NULL')
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
  and c.relname in ('kpi_core_actions','kpi_business_activity','call_list_interview','call_list_referral','call_list_welcome')
union all
select 'anon_or_authenticated_can_select_views (expect 0)', count(*)::text
from unnest(array['kpi_core_actions','kpi_business_activity','call_list_interview','call_list_referral','call_list_welcome']) v,
     unnest(array['anon','authenticated']) r
where has_table_privilege(r, 'public.' || v, 'select')
union all
select 'drifted_orders (expect 5 on prod)', count(*)::text
from sale_orders so
join (select order_id, sum(qty * unit_price) s from so_lines group by 1) l on l.order_id = so.id
where so.status in ('paye','credit') and abs(so.total_amount - l.s) >= 1
union all
select 'kpi_view_chain_evaluates (row count)', (select count(*) from kpi_business_activity)::text
order by 1;
