-- migration_v41: supplier_debts
-- Tracks what the business owes to each supplier (reverse of client ledger).
-- Amounts stored as BIGINT cents (×100), same convention as all other monetary columns.

create table supplier_debts (
  id          uuid        primary key default gen_random_uuid(),
  business_id uuid        not null references businesses(id) on delete cascade,
  supplier_id uuid        not null references suppliers(id)  on delete cascade,
  amount      bigint      not null check (amount > 0),
  description text,
  date        date        not null default current_date,
  amount_paid bigint      not null default 0 check (amount_paid >= 0),
  created_by  uuid        not null references profiles(id),
  created_at  timestamptz not null default now()
);

alter table supplier_debts enable row level security;

create policy "supplier_debts_select" on supplier_debts
  for select using (is_member(business_id));

create policy "supplier_debts_insert" on supplier_debts
  for insert with check (get_role(business_id) in ('administrateur', 'manager'));

create policy "supplier_debts_update" on supplier_debts
  for update using (get_role(business_id) in ('administrateur', 'manager'));

create policy "supplier_debts_delete" on supplier_debts
  for delete using (get_role(business_id) in ('administrateur', 'manager'));
