# Test Truth Doctrine — Patron

## Why this exists
Patron is a ledger. Our vendors' paper carnets never forget a sale and never invent one. If Patron does either, it is worse than paper — and in a market, reputation spreads by word of mouth. Every bug class we care about touches money or memory. A green suite that doesn't verify behavior is not a safety net; it is a blindfold.

Our tests are written by coding agents. Industry research (2026) found ~80% of agent-written test patches have weak or missing oracles — the test runs but doesn't really check the answer. We assume the test author is eager to please, and we verify anyway.

## Ground rules (eternal)
Practices, not tools. Tools get pinned and replaced; these don't change.

1. **Red-then-green.** Every bug fix ships with a regression test that FAILS before the fix and PASSES after. A test that failed pre-fix provably checks the real behavior. Report both runs with counts.
2. **Real database.** Money/sync/payment integration tests run against real Postgres, never mocks. Mocks drift from reality.
3. **Sabotage checks on money paths.** Regularly verify the suite catches deliberately broken code (mutation testing). A test that stays green when the code is wrong is worthless — rewrite it.
4. **Money invariants as properties.** Conservation of money, rounding rules, exactly-once sync — mathematical truths about the domain, tested as properties, not examples. They don't churn when the UI changes.
5. **The physical test.** Airplane mode → record sale → kill app → reopen → reconnect → exactly one sync, nothing lost, nothing duplicated. No tool replaces the phone in hand.
6. **Assertion hygiene.** Every test has a real assertion that can fail. No `.only` or `test.skip` committed. No snapshots for behavior.

## Consequence tiers (where the rigor goes)
One developer, $0 budget. Rigor is spent where consequences live.

- **Tier 1 — money paths** (payments, idempotency keys, outbox drain/sync, rounding and money math, ledger balances): everything above, maximum, forever. Mutation-tested. Property-tested. Real-DB. Red-then-green.
- **Tier 2 — data integrity** (migrations, offline storage, conflict handling): real-DB integration + red-then-green. Mutation only where cheap.
- **Tier 3 — everything else** (UI, copy, navigation, polish): behavioral assertions, no snapshots, no mutation. Light and fast.

Tie-breaker: "if this is wrong, does a vendor lose money or records?" Yes → Tier 1.

## Pinned tools (change deliberately, never fashionably)
- Mutation: StrykerJS 9.6.x, scoped to Tier 1 paths, `npm run test:mutation`, weekly — never per-PR.
- Properties: fast-check v4.
- Lint: eslint-plugin-jest as errors — no-focused-tests, no-disabled-tests, expect-expect, no-conditional-expect, no-standalone-expect.
- Snapshots: `toMatchSnapshot` banned for behavior; tiny inline snapshots only for serialized contracts.

## The Done Rule
Nothing is done / live / shipped / fixed / working until all three hold: **merged** (purple GitHub Merged badge on main — Closed is not merged), **deployed** (verified on the real live target), **tested** (green run on the final merged state, with suite/test counts). Agent work ends at "PR open, CI green." Sebastiao merges manually.
