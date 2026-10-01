# Alpha — Phase 0 Audit (read-only) — "Put Alpha behind a glass wall"

Date: 2026-09-30 · Scope: §6 pre-launch checklist, item 6 (0/10)

This audit changed **nothing**. It maps what already exists so the glass-wall
rework (Phases 1–6) lands on real surfaces instead of assumptions.

---

## 1. Query layers & totals — where figures are computed today

Alpha **already exists**. It was shipped as "Mystic" ([`db/migration_v133.sql`](db/migration_v133.sql:1))
and renamed to "Alpha" one migration later ([`db/migration_v134.sql`](db/migration_v134.sql:1)).
The §6 task is a **security-hardening rework of an existing feature**, not a
from-scratch build. The existing grounding path is entirely in
[`supabase/functions/alpha-chat/index.ts`](supabase/functions/alpha-chat/index.ts:1).

### Ventes (sales)
- **One source of truth:** [`get_reports_snapshot()`](db/migration_v121.sql:27) — `SECURITY DEFINER`,
  JWT-scoped. The v121 security fix means it **derives `role` and `user_id` from
  `auth.uid()`/`get_role()` server-side** and ignores caller-supplied
  `p_role`/`p_user_id` for authenticated callers (service-role keeps the
  internal-reconciliation path).
- It computes: revenue, COGS, stock losses, gross profit, operating expenses,
  shipping, net profit, credit outstanding + count, order count, cash on hand,
  stock value, capital apports, daily activity chart, and a **staff** top-sellers
  leaderboard (`top_sellers` — people, not products).
- All money math is in SQL, in **BIGINT cents**, converted to display units
  (÷100) only at the edge-function boundary before the prompt.
- Revenue convention everywhere: `so.status IN ('paye','credit')` — real closed
  sales, not "everything not cancelled" ([`db/migration_v160.sql`](db/migration_v160.sql:1)).

### Crédits / clients (credit & customers)
- Credit outstanding is computed **inside** `get_reports_snapshot` (all-time
  `credit_outstanding` + `credit_count`, per-order `GREATEST(0, total - discounts - paid)`).
- Per-client history is computed on demand by the edge function's
  `chercher_client` tool via `clients` + `sale_orders` through the **caller's JWT**
  (RLS-gated), not a dedicated RPC.
- `payments` is the paid-amount table; `credit` orders with `total_paid < total`
  constitute debt.

### Stock / produits (stock & products)
- [`get_stock_velocity()`](db/migration_v87.sql:20) — 90-day weighted velocity →
  `days_remaining` per plain product / variant (`-1` = out of stock, `NULL` = no
  sales, else capped at 999). `SECURITY DEFINER`, `is_member` gate only.
- [`get_best_sellers()`](db/migration_v198.sql:180) — top products by revenue,
  `paye`/`credit` only, `archived=false`, `is_system=false`. **No role gate of its
  own** (`is_member` only) — the edge function currently withholds it from vendeur
  in code.
- [`get_product_stats()`](db/migration_v160.sql:30) — per-product lifetime
  revenue/capital/profit. **No role gate of its own** (`is_member` only); profit
  is withheld from vendeur in code today.

### Role model & what each role sees
- Roles: `administrateur | manager | vendeur | investisseur`
  ([`db/schema.sql`](db/schema.sql:90) via [`get_role()`](db/schema.sql:90)).
  Spec's "gérant" = `manager`; spec's "observateur" = `investisseur`
  (per `BusinessDrawer` ROLE_LABEL).
- `investisseur` is **excluded** from `sale_orders` SELECT entirely
  ([`db/schema.sql`](db/schema.sql:333) — `get_role(business_id) != 'investisseur'`),
  but sees full financials via `get_reports_snapshot`'s investisseur branch.
- `vendeur` sees **only their own sales/credits** via `get_reports_snapshot`'s
  vendeur branch (`seller_id = auth.uid()`), plus RLS on `sale_orders`.
- `vendeur` **never sees `cost_price`**: RLS blocks it directly and SECURITY
  DEFINER RPCs return `0` to vendeur ([`db/migration_v193.sql`](db/migration_v193.sql:1)).

---

## 2. Currency & purchase-price storage

### Currency
- Per-business `businesses.currency TEXT NOT NULL DEFAULT 'GNF'`
  ([`db/schema.sql`](db/schema.sql:53)).
- Supported list in [`src/constants/currency.ts`](src/constants/currency.ts:8) includes
  **GNF and USD** (and XOF, XAF, NGN, GHS, …). `inferCurrency(phone)` defaults GNF.
- The edge function already injects `business.currency` into the system prompt.

### Purchase prices — can they be empty?
- `products.cost_price` is **`BIGINT NOT NULL DEFAULT 0`** (cents, ×100 since
  `migration_v24` converted numeric→BIGINT). **It is never truly NULL** — an
  "empty" / missing purchase price is **`cost_price = 0`**, not NULL.
- `product_variants.cost_price` — same BIGINT-cents convention.
- `so_lines.cost_price_at_sale` is a **nullable** snapshot (NULL for pre-v81 rows).
  COGS fallback chain: `COALESCE(cost_price_at_sale, pv.cost_price, p.cost_price, 0)`.
- **Consequence for the spec's "margins excluded if purchase price missing":**
  "missing cost" must be detected as **`cost_price = 0`** (or a zero/absent
  `cost_price_at_sale` fallback), *not* NULL. For `vendeur`, cost is always seen
  as `0` (v193 gate), so **margins must be excluded for vendeur by construction** —
  they cannot distinguish "real 0 cost" from "hidden cost".

---

## 3. "Assistant IA" entry point & chat insertion

- **Entry:** the hamburger drawer footer already has an **"Assistant IA"** row
  (sparkles icon) that pushes `/(app)/alpha`
  ([`src/components/BusinessDrawer.tsx`](src/components/BusinessDrawer.tsx:324)).
  This is the relocated entry point referenced by the spec — no new entry needed.
- **Chat screen:** [`app/(app)/alpha/index.tsx`](app/(app)/alpha/index.tsx:90).
- **State:** [`stores/alpha.ts`](stores/alpha.ts:49) (Zustand) — optimistic
  `sendMessage` → `send_alpha_message` RPC → detached `alpha-chat` edge-function
  invoke; `fetchQuota` → `get_alpha_quota_status`.
- **Conversation/message schema:** `alpha_conversations` (one per business+user),
  `alpha_messages` (`role`, `content`, `status`, `error_note`, `model`, `created_at`),
  `alpha_quota` (rolling 24h window) — all from v133/v134.

---

## 4. Blockers / gaps for the plan (flagged, not reinterpreted)

1. **Voice is "vous", spec requires "tu".** [`STATIC_INSTRUCTIONS`](supabase/functions/alpha-chat/index.ts:122)
   mandates vouvoiement. Phase 2 flips this.
2. **Model-chosen tools exist.** The current design gives the model 4
   `TOOLS` + `tool_choice:'auto'` ([`supabase/functions/alpha-chat/index.ts`](supabase/functions/alpha-chat/index.ts:383)).
   The spec forbids model-chosen data sources — Phase 1 replaces this with a
   deterministic intention→skill router; tools must be removed/disabled.
3. **Margins are currently exposed** (`gross_profit`, `net_profit`, `cogs` in the
   data block, plus `get_product_stats` profit). Spec excludes margins at launch.
4. **No deterministic router / skills / envelope.** Nothing matches the
   `{valeur(s), période, provenance, chemin_détails, version_données}` envelope.
5. **Quota ≠ the spec's "30 calls/day default".** Current model: rolling 24h,
   free 5 / paid 100, live-configurable via `app_config`
   ([`db/migration_v147.sql`](db/migration_v147.sql:23)). The spec wants a
   server-side daily per-user cap (default 30, configurable). **Safer
   interpretation (flagged):** keep the existing free/paid quota AND add a new
   hard 30/day cost cap + anomaly alert; do not silently change the existing
   entitlement numbers.
6. **No audit trail.** `alpha_messages` has no `intention`, `params`,
   `data_hash`, `cost`, or per-interaction role/business/model fields. Phase 6
   needs a migration.
7. **No per-business data-version revision counter.** Cache keys on data version
   require a counter incremented on every write (sale, payment, stock) — doesn't
   exist yet.
8. **No cost capture** beyond `alpha_messages.model` — provider usage tokens and
   per-call cost are not recorded.
9. **No anomaly alert** (>3× rolling baseline) infrastructure.
10. **"Voir les détails" deep link** to exact underlying records needs a
    `chemin_détails` payload + frontend routing support (filtered list screen).
11. **DB-test safety gate.** Integration tests hit a **local** Supabase stack
    (Colima/Docker, `scripts/test-db-setup.js`, TEST keys only —
    [`__tests__/integration/helpers.ts`](__tests__/integration/helpers.ts:6)).
    Per the spec, any DB test must prove the target is a **test** Postgres, never
    prod. Confirmed: the harness hardcodes `127.0.0.1:54321` + well-known local
    keys; no prod URL/key path exists.
12. **Migration numbering.** Latest is `migration_v206.sql`. Next new migration
    must be `migration_v210.sql`.
