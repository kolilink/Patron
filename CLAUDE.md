# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Expo has changed significantly.** Always read the versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing Expo-specific code.

## Project

**Patron** is a React Native (Expo Router v6) mobile commerce management app targeting small businesses in West Africa. UI and all labels are in French. Supports multiple currencies. Designed for iOS and Android (no web PWA target).

## Commands

```bash
# Dev server
npx expo start
npx expo start --ios
npx expo start --android

# Type-check (no test suite, no linter)
npx tsc --noEmit
```

No test suite. No linting config.

## Architecture

### Routing (Expo Router v6 file-based)

```
app/
  _layout.tsx           — Root layout: initializes auth + SQLite, hides splash
  index.tsx             — Redirects to (auth) or (app) based on session
  (auth)/               — Unauthenticated: connexion, inscription
  (app)/
    _layout.tsx         — Guards: redirects to (auth)/connexion if no session
    (tabs)/             — Bottom tabs: Accueil, Catalogue, Caisse, Plus
    onboarding/         — Create or join a business after first login
    ventes/             — Sales list + detail
    depenses/           — Expense management
    equipe/             — Team management
    fournisseurs/       — Supplier management
    clients/            — Customer list
    rapports/           — Reports
    parametres/         — Settings
```

`investisseur` role sees only the Accueil and Plus tabs — Catalogue and Caisse use `href: null` to hide them.

### Auth flow

`stores/auth.ts` (`useAuthStore`) is a Zustand store initialized in the root `_layout.tsx` via `initialize()`. It calls `supabase.auth.getSession()` and loads the user's profile + memberships into `AppSession`. If the user has exactly one business it auto-selects it; otherwise `(app)/onboarding` prompts selection. The `(app)/_layout.tsx` redirects to `/(auth)/connexion` when no session.

Creating a business generates the UUID client-side first, then inserts — this avoids an RLS race where `SELECT` after `INSERT ... RETURNING` fires before the `handle_business_created` trigger creates the membership row.

### Store pattern (Zustand, `stores/`)

All domain stores use Zustand with direct Supabase calls — no local write-through cache (unlike `corning`). Stores hold arrays of fetched records and expose `loading`/`saving` flags. The `ventes` store (`stores/ventes.ts`) additionally enriches records with seller names by joining `profiles`.

### Offline layer (`lib/db.ts`)

`expo-sqlite` opens `patron.db` with WAL mode on first call (`openDb()`). A lightweight `migrate()` function tracks applied versions in `_migrations`. Current tables: `local_products`, `local_sale_orders`, `local_so_lines`, `local_payments`, `sync_queue`. Each has a `dirty` flag and `synced_at` field for future sync. Cloud stores (`stores/`) write directly to Supabase; the SQLite layer is for offline queue/draft support.

### Theme (`src/theme/`)

Import from `@/src/theme` — `palette` for semantic tokens, `colors` for the full scale. Primary color is indigo (`#6366F1` / `colors.primary[500]`). Role colors: administrateur=indigo, manager=cyan, vendeur=green, investisseur=amber. Do **not** use hardcoded hex values in screens; reference `palette` tokens.

### Types (`src/types/index.ts`)

Defines all domain types. Key ones:
- `Role`: `administrateur | manager | vendeur | investisseur`
- `OrderStatus`: `brouillon | confirme | annule | paye | credit`
- `AppSession`: `{ user, activeBusiness, activeMembership, memberships }`
- `Business`: multi-tenant entity, currency field per-business

### DB schema & migrations

- `db/schema.sql` — base Supabase schema (run first in SQL Editor)
- `db/migration_v2.sql`, `migration_v3.sql` — incremental Supabase migrations
- `lib/db.ts` — SQLite local migrations (auto-run on app start)

RLS uses `is_member(business_id)` helper function defined in the base schema.

### Supabase client (`lib/supabase.ts`)

Uses `expo-secure-store` for session storage. The `@/` alias maps to the project root (configured in `tsconfig.json`).
