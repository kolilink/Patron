---
name: verify
description: Systematic post-build verification for Patron. Runs tsc, reviews the change for architecture violations, and confirms behavior is correct before declaring done. Never skip this after a coding task.
---

# Verify

Run this after completing any coding task. "It looks right" is not done. This is done.

## When to use

After writing or editing any of: screens, stores, components, migrations, edge functions, lib utilities. Basically after any code change.

## Verification checklist

Work through every check below. Fix issues as you find them before moving to the next check.

### 1. TypeScript
```bash
cd Patron && npx tsc --noEmit
```
Zero errors required. If errors exist, fix them now — do not report done with outstanding TS errors.

### 2. Architecture rules
Review the changed files against these non-negotiables:

- **Monetary amounts**: any value written to DB is ×100 (BIGINT cents). Any value displayed uses `formatAmount(n, currency)`. No raw number display.
- **Theme**: no hardcoded hex values in screens or components. All colors come from `palette` via `useTheme()`.
- **Auth loading flag**: nothing sets `loading: true` on `useAuthStore` from inside the app. In-app async ops use their own flag.
- **Error messages**: Supabase errors go through `translateError()` before display. Never show raw error strings.
- **Writes**: vendeur-triggered writes go through SECURITY DEFINER RPCs, not direct table inserts.
- **Offline**: if the change touches a write operation, confirm it either uses the SQLite queue or explains why it doesn't need to.
- **Safe area — Screen component**: every new screen file under `app/` must use `<Screen>` (from `@/src/components/ui/Screen`) as its root, not raw `<SafeAreaView>`. Run this check on any new or modified screen file:
  ```bash
  grep -n "SafeAreaView" <file> | grep -v "import\|modalSafe\|Modal"
  ```
  Any hit that is NOT inside a `<Modal>` is a violation. Tab screens use `<Screen tab>`, standard screens use `<Screen>`, screens that handle bottom insets manually use `<Screen edges={['top']}>`. `SafeAreaView` is only allowed inside `<Modal>` wrappers.

### 3. Role behavior
If the change affects what a user sees or can do, mentally run through all four roles:
- `administrateur` — should this work for them? ✓/✗
- `manager` — same? ✓/✗
- `vendeur` — same? Does RLS block anything it shouldn't? ✓/✗
- `investisseur` — read-only; are they accidentally blocked or accidentally given write access? ✓/✗

### 4. Loading and error states
- Does the screen handle `loading === true` (skeleton or spinner)?
- Does it handle a Supabase error gracefully (toast, not crash)?
- Does it handle empty data (empty state UI, not a blank screen)?

### 5. Behavioral check
State out loud what the feature does end-to-end, step by step, as if explaining to the user. If any step sounds uncertain ("I think it does X"), that's a flag — read the code again or trace the data flow.

### 6. Migration safety (if a migration was written)
- Is the version number one higher than the latest in `db/`?
- Does it avoid breaking changes to existing RPC signatures that the app calls?
- If it modifies monetary columns, are they BIGINT?
- If it adds a NOT NULL column, does it have a DEFAULT or a backfill?

## Output

After all checks pass, report:
```
VERIFY PASSED

tsc: clean
Architecture: [any notes or "all clear"]
Roles: [any notes or "all clear"]  
States: [any notes or "all clear"]
Behavior: [one sentence confirming what the change does]
```

If any check fails, fix it first — don't output a partial pass.
