-- ============================================================
-- Patron — Supabase Schema v1  (fully idempotent — safe to re-run)
-- Run in Supabase SQL Editor (https://supabase.com/dashboard)
-- ============================================================

-- ─── TRIGGER: auto-create profile on signup ──────────────────
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, email, language)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email,
    'fr'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ─── PROFILES ────────────────────────────────────────────────
create table if not exists profiles (
  id         uuid        references auth.users(id) on delete cascade primary key,
  name       text        not null,
  email      text        not null,
  phone      text,
  avatar_url text,
  language   text        not null default 'fr',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table profiles enable row level security;

drop policy if exists "Voir son profil"   on profiles;
drop policy if exists "Modifier son profil" on profiles;
drop policy if exists "Créer son profil"  on profiles;

create policy "Voir son profil"    on profiles for select using (auth.uid() = id);
create policy "Modifier son profil" on profiles for update using (auth.uid() = id);
create policy "Créer son profil"   on profiles for insert with check (auth.uid() = id);

-- ─── BUSINESSES ──────────────────────────────────────────────
create table if not exists businesses (
  id                uuid        primary key default gen_random_uuid(),
  name              text        not null,
  type              text,
  currency          text        not null default 'GNF',
  logo_url          text,
  status            text        not null default 'actif'
                    check (status in ('actif','suspendu','archive')),
  subscription_tier text        not null default 'gratuit'
                    check (subscription_tier in ('gratuit','starter','business','pro')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid        not null references auth.users(id)
);

alter table businesses enable row level security;

-- ─── MEMBERSHIPS ─────────────────────────────────────────────
create table if not exists memberships (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  business_id uuid        not null references businesses(id) on delete cascade,
  role        text        not null
              check (role in ('administrateur','manager','vendeur','investisseur')),
  pin_hash    text,
  joined_at   timestamptz not null default now(),
  unique (user_id, business_id)
);

alter table memberships enable row level security;

-- ─── HELPER FUNCTIONS ────────────────────────────────────────
create or replace function is_member(bid uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from memberships
    where user_id = auth.uid() and business_id = bid
  );
$$;

create or replace function get_role(bid uuid)
returns text language sql security definer stable as $$
  select role from memberships
  where user_id = auth.uid() and business_id = bid
  limit 1;
$$;

-- Business policies
drop policy if exists "Membres: voir leur commerce"         on businesses;
drop policy if exists "Tout le monde: créer un commerce"    on businesses;
drop policy if exists "Administrateurs: modifier leur commerce" on businesses;

create policy "Membres: voir leur commerce"
  on businesses for select using (is_member(id));
create policy "Tout le monde: créer un commerce"
  on businesses for insert with check (auth.uid() = created_by);
create policy "Administrateurs: modifier leur commerce"
  on businesses for update using (get_role(id) = 'administrateur');

-- Membership policies
drop policy if exists "Membres: voir leurs adhésions" on memberships;
drop policy if exists "Adhésion propre uniquement"    on memberships;

create policy "Membres: voir leurs adhésions"
  on memberships for select using (
    user_id = auth.uid() or is_member(business_id)
  );
create policy "Adhésion propre uniquement"
  on memberships for insert with check (user_id = auth.uid());

-- ─── INVITE CODES ────────────────────────────────────────────
create table if not exists invite_codes (
  id          uuid        primary key default gen_random_uuid(),
  business_id uuid        not null references businesses(id) on delete cascade,
  code        text        not null unique,
  role        text        not null default 'vendeur'
              check (role in ('manager','vendeur','investisseur')),
  created_by  uuid        not null references auth.users(id),
  expires_at  timestamptz,
  max_uses    int         default 10,
  uses        int         not null default 0,
  created_at  timestamptz not null default now()
);

alter table invite_codes enable row level security;

drop policy if exists "Lecture codes publique"            on invite_codes;
drop policy if exists "Admins/Managers: créer des codes"  on invite_codes;
drop policy if exists "Admins/Managers: mettre à jour les codes" on invite_codes;

create policy "Lecture codes publique"
  on invite_codes for select using (true);
create policy "Admins/Managers: créer des codes"
  on invite_codes for insert with check (
    get_role(business_id) in ('administrateur','manager')
  );
create policy "Admins/Managers: mettre à jour les codes"
  on invite_codes for update using (
    get_role(business_id) in ('administrateur','manager')
  );

-- ─── PRODUCTS ────────────────────────────────────────────────
create table if not exists products (
  id            uuid           primary key default gen_random_uuid(),
  business_id   uuid           not null references businesses(id) on delete cascade,
  name          text           not null,
  sku           text,
  category      text,
  unit          text           not null default 'pcs',
  cost_price    numeric(15,2)  not null default 0,
  sale_price    numeric(15,2)  not null default 0,
  reorder_level numeric(15,2)  not null default 0,
  stock_qty     numeric(15,2)  not null default 0,
  archived      boolean        not null default false,
  created_at    timestamptz    not null default now(),
  updated_at    timestamptz    not null default now(),
  created_by    uuid           not null references auth.users(id)
);

alter table products enable row level security;

drop policy if exists "Membres: voir les produits"       on products;
drop policy if exists "Membres actifs: gérer les produits" on products;

create policy "Membres: voir les produits"
  on products for select using (is_member(business_id));
create policy "Membres actifs: gérer les produits"
  on products for all using (
    get_role(business_id) in ('administrateur','manager','vendeur')
  );

-- ─── STOCK MOVES ─────────────────────────────────────────────
create table if not exists stock_moves (
  id          uuid          primary key default gen_random_uuid(),
  business_id uuid          not null references businesses(id) on delete cascade,
  product_id  uuid          not null references products(id),
  type        text          not null check (type in ('entree','sortie','perte','retour')),
  qty         numeric(15,2) not null,
  ref_id      uuid,
  ref_type    text,
  note        text,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now(),
  created_by  uuid          not null references auth.users(id)
);

alter table stock_moves enable row level security;

drop policy if exists "Membres: voir les mouvements"        on stock_moves;
drop policy if exists "Membres actifs: créer des mouvements" on stock_moves;

create policy "Membres: voir les mouvements"
  on stock_moves for select using (is_member(business_id));
create policy "Membres actifs: créer des mouvements"
  on stock_moves for insert with check (
    get_role(business_id) in ('administrateur','manager','vendeur')
  );

-- ─── SUPPLIERS ───────────────────────────────────────────────
create table if not exists suppliers (
  id          uuid        primary key default gen_random_uuid(),
  business_id uuid        not null references businesses(id) on delete cascade,
  name        text        not null,
  phone       text,
  country     text,
  lead_days   int,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid        not null references auth.users(id)
);

alter table suppliers enable row level security;

drop policy if exists "Membres: voir les fournisseurs"      on suppliers;
drop policy if exists "Admins/Managers: gérer les fournisseurs" on suppliers;

create policy "Membres: voir les fournisseurs"
  on suppliers for select using (is_member(business_id));
create policy "Admins/Managers: gérer les fournisseurs"
  on suppliers for all using (
    get_role(business_id) in ('administrateur','manager')
  );

-- ─── PURCHASE ORDERS ─────────────────────────────────────────
create table if not exists purchase_orders (
  id          uuid          primary key default gen_random_uuid(),
  business_id uuid          not null references businesses(id) on delete cascade,
  supplier_id uuid          not null references suppliers(id),
  status      text          not null default 'brouillon'
              check (status in ('brouillon','envoye','recu_partiel','recu','annule')),
  ordered_at  timestamptz   not null default now(),
  received_at timestamptz,
  total_cost  numeric(15,2) not null default 0,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now(),
  created_by  uuid          not null references auth.users(id)
);

alter table purchase_orders enable row level security;

drop policy if exists "Membres: voir les achats"       on purchase_orders;
drop policy if exists "Admins/Managers: gérer les achats" on purchase_orders;

create policy "Membres: voir les achats"
  on purchase_orders for select using (is_member(business_id));
create policy "Admins/Managers: gérer les achats"
  on purchase_orders for all using (
    get_role(business_id) in ('administrateur','manager')
  );

-- ─── PO LINES ────────────────────────────────────────────────
create table if not exists po_lines (
  id           uuid          primary key default gen_random_uuid(),
  po_id        uuid          not null references purchase_orders(id) on delete cascade,
  product_id   uuid          not null references products(id),
  qty_ordered  numeric(15,2) not null,
  qty_received numeric(15,2) not null default 0,
  unit_cost    numeric(15,2) not null
);

alter table po_lines enable row level security;

drop policy if exists "Voir les lignes d'achat"              on po_lines;
drop policy if exists "Admins/Managers: gérer les lignes d'achat" on po_lines;

create policy "Voir les lignes d'achat"
  on po_lines for select using (
    exists (
      select 1 from purchase_orders po
      where po.id = po_id and is_member(po.business_id)
    )
  );
create policy "Admins/Managers: gérer les lignes d'achat"
  on po_lines for all using (
    exists (
      select 1 from purchase_orders po
      join memberships m on m.business_id = po.business_id
      where po.id = po_id
        and m.user_id = auth.uid()
        and m.role in ('administrateur','manager')
    )
  );

-- ─── SALE ORDERS ─────────────────────────────────────────────
create table if not exists sale_orders (
  id            uuid          primary key default gen_random_uuid(),
  business_id   uuid          not null references businesses(id) on delete cascade,
  customer_name text,
  seller_id     uuid          not null references auth.users(id),
  status        text          not null default 'brouillon'
                check (status in ('brouillon','confirme','annule','paye','credit')),
  paid_at       timestamptz,
  total_amount  numeric(15,2) not null default 0,
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now(),
  created_by    uuid          not null references auth.users(id)
);

alter table sale_orders enable row level security;

drop policy if exists "Membres non-investisseurs: voir les ventes" on sale_orders;
drop policy if exists "Vendeurs: créer des ventes"                 on sale_orders;
drop policy if exists "Admins/Managers: modifier les ventes"       on sale_orders;

create policy "Membres non-investisseurs: voir les ventes"
  on sale_orders for select using (
    is_member(business_id) and get_role(business_id) != 'investisseur'
  );
create policy "Vendeurs: créer des ventes"
  on sale_orders for insert with check (
    get_role(business_id) in ('administrateur','manager','vendeur')
    and seller_id = auth.uid()
  );
create policy "Admins/Managers: modifier les ventes"
  on sale_orders for update using (
    get_role(business_id) in ('administrateur','manager')
  );

-- ─── SO LINES ────────────────────────────────────────────────
create table if not exists so_lines (
  id         uuid          primary key default gen_random_uuid(),
  order_id   uuid          not null references sale_orders(id) on delete cascade,
  product_id uuid          not null references products(id),
  qty        numeric(15,2) not null,
  unit_price numeric(15,2) not null
);

alter table so_lines enable row level security;

drop policy if exists "Voir les lignes de vente"             on so_lines;
drop policy if exists "Membres actifs: gérer les lignes de vente" on so_lines;

create policy "Voir les lignes de vente"
  on so_lines for select using (
    exists (
      select 1 from sale_orders so
      where so.id = order_id
        and is_member(so.business_id)
        and get_role(so.business_id) != 'investisseur'
    )
  );
create policy "Membres actifs: gérer les lignes de vente"
  on so_lines for all using (
    exists (
      select 1 from sale_orders so
      join memberships m on m.business_id = so.business_id
      where so.id = order_id
        and m.user_id = auth.uid()
        and m.role in ('administrateur','manager','vendeur')
    )
  );

-- ─── PAYMENTS ────────────────────────────────────────────────
create table if not exists payments (
  id           uuid          primary key default gen_random_uuid(),
  order_id     uuid          not null references sale_orders(id) on delete cascade,
  method       text          not null
               check (method in ('especes','wave','orange','mtn','moov','credit')),
  amount       numeric(15,2) not null,
  ref_external text,
  created_at   timestamptz   not null default now()
);

alter table payments enable row level security;

drop policy if exists "Voir les paiements"                   on payments;
drop policy if exists "Membres actifs: enregistrer les paiements" on payments;

create policy "Voir les paiements"
  on payments for select using (
    exists (
      select 1 from sale_orders so
      where so.id = order_id and is_member(so.business_id)
    )
  );
create policy "Membres actifs: enregistrer les paiements"
  on payments for insert with check (
    exists (
      select 1 from sale_orders so
      join memberships m on m.business_id = so.business_id
      where so.id = order_id
        and m.user_id = auth.uid()
        and m.role in ('administrateur','manager','vendeur')
    )
  );

-- ─── INVESTORS ───────────────────────────────────────────────
create table if not exists investors (
  id          uuid          primary key default gen_random_uuid(),
  business_id uuid          not null references businesses(id) on delete cascade,
  user_id     uuid          not null references auth.users(id),
  amount      numeric(15,2) not null,
  invested_at timestamptz   not null,
  note        text,
  equity_pct  numeric(5,2)  not null default 0,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now(),
  created_by  uuid          not null references auth.users(id)
);

alter table investors enable row level security;

drop policy if exists "Investisseurs: voir leurs données"  on investors;
drop policy if exists "Administrateurs: gérer les investisseurs" on investors;

create policy "Investisseurs: voir leurs données"
  on investors for select using (
    user_id = auth.uid() or get_role(business_id) = 'administrateur'
  );
create policy "Administrateurs: gérer les investisseurs"
  on investors for all using (get_role(business_id) = 'administrateur');

-- ─── CHANGE PROPOSALS ────────────────────────────────────────
create table if not exists change_proposals (
  id          uuid        primary key default gen_random_uuid(),
  business_id uuid        not null references businesses(id) on delete cascade,
  entity_type text        not null,
  entity_id   uuid        not null,
  proposed_by uuid        not null references auth.users(id),
  status      text        not null default 'en_attente'
              check (status in ('en_attente','approuve','rejete','clarification')),
  diff_json   jsonb       not null,
  reviewed_by uuid        references auth.users(id),
  reviewed_at timestamptz,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid        not null references auth.users(id)
);

alter table change_proposals enable row level security;

drop policy if exists "Membres: voir les propositions"          on change_proposals;
drop policy if exists "Membres actifs: soumettre des propositions" on change_proposals;
drop policy if exists "Admins/Managers: traiter les propositions"  on change_proposals;

create policy "Membres: voir les propositions"
  on change_proposals for select using (is_member(business_id));
create policy "Membres actifs: soumettre des propositions"
  on change_proposals for insert with check (
    get_role(business_id) in ('administrateur','manager','vendeur')
  );
create policy "Admins/Managers: traiter les propositions"
  on change_proposals for update using (
    get_role(business_id) in ('administrateur','manager')
  );

-- ─── AUDIT LOG (append-only) ─────────────────────────────────
create table if not exists audit_log (
  id           bigserial   primary key,
  business_id  uuid        not null references businesses(id) on delete cascade,
  actor_id     uuid        not null references auth.users(id),
  action       text        not null,
  entity_type  text        not null,
  entity_id    text        not null,
  payload_json jsonb       not null default '{}',
  ip           text,
  ts           timestamptz not null default now()
);

alter table audit_log enable row level security;

drop policy if exists "Admins: voir les logs"       on audit_log;
drop policy if exists "Membres: insérer dans les logs" on audit_log;

create policy "Admins: voir les logs"
  on audit_log for select using (get_role(business_id) = 'administrateur');
create policy "Membres: insérer dans les logs"
  on audit_log for insert with check (
    is_member(business_id) and actor_id = auth.uid()
  );

-- ─── UPDATED_AT TRIGGERS ─────────────────────────────────────
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at        on profiles;
drop trigger if exists trg_businesses_updated_at      on businesses;
drop trigger if exists trg_products_updated_at        on products;
drop trigger if exists trg_sale_orders_updated_at     on sale_orders;
drop trigger if exists trg_purchase_orders_updated_at on purchase_orders;
drop trigger if exists trg_change_proposals_updated_at on change_proposals;

create trigger trg_profiles_updated_at
  before update on profiles for each row execute function set_updated_at();
create trigger trg_businesses_updated_at
  before update on businesses for each row execute function set_updated_at();
create trigger trg_products_updated_at
  before update on products for each row execute function set_updated_at();
create trigger trg_sale_orders_updated_at
  before update on sale_orders for each row execute function set_updated_at();
create trigger trg_purchase_orders_updated_at
  before update on purchase_orders for each row execute function set_updated_at();
create trigger trg_change_proposals_updated_at
  before update on change_proposals for each row execute function set_updated_at();
