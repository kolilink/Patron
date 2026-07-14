# TODOS

## Dashboard

### Unify duplicate currency-formatting helpers in index.tsx

**What:** `app/(app)/(tabs)/index.tsx` has two parallel ways to format money — the shared `formatAmount` (`src/utils/format.ts`), used for investor-branch amounts, and a local `fmt(n, cur)` helper plus `amtOrMask`/`rawOrMask` privacy wrappers, used in the owner/vendeur hero and KPI cards. They produce near-identical output but aren't the same code path.

**Why:** A future currency-display fix (e.g. a locale or rounding bug) would need to be found and applied in two places instead of one. Low urgency today, but it's the kind of thing that compounds — every new KPI card added to this file has to guess which convention applies.

**Context:** Found during `plan-eng-review` on 2026-07-09, while designing a new "today's total sales" dashboard card (see `~/.gstack/projects/kolilink-Patron/mamadousebastiaodiallo-main-design-20260709-215804.md`). Deliberately not fixed as part of that change to keep the diff minimal — the new card follows the existing `fmt`/`amtOrMask` convention since it lives in the owner/vendeur section. Whoever picks this up should audit every `fmt(`/`amtOrMask(`/`formatAmount(` call site in `index.tsx` and collapse to one shared utility, preserving the privacy-mask behavior (`amtOrMask`/`rawOrMask`) which `formatAmount` doesn't currently have.

**Effort:** S
**Priority:** P3
**Depends on:** None
