---
name: roast
description: Stress-test a feature idea or technical approach before writing any code. Runs a council of perspectives and returns a verdict — green-light, reshape, or kill — plus the cheapest way to validate in 48 hours.
---

# Roast

Before writing any code, migration, or new screen, run this to stress-test the idea from multiple angles.

## When to use

Trigger this whenever the user proposes:
- A new feature or screen
- A new DB migration that changes data shape
- A new store or significant refactor
- A product decision (pricing, flow, UX pattern)

## How to run

**Step 1 — Clarify if needed.** If the idea is vague, ask up to 3 quick questions before proceeding:
- Who benefits from this? (which role: admin / manager / vendeur / investisseur / all)
- What problem does it solve that doesn't already exist in the app?
- Any constraints? (time, budget, "must ship this week")

If the idea is clear enough, skip straight to Step 2.

**Step 2 — Spin up the council.** Evaluate the idea through these five lenses in parallel (use sub-agents if the idea is complex enough to warrant it, otherwise work through each lens yourself):

### The Five Lenses

**Contrarian** — Find the fatal flaw. What is the single most likely reason this fails or has to be ripped out in 3 months? Focus on: data model traps, RLS edge cases, offline behavior, scope creep, maintenance burden.

**User advocate** — Play the role of a boutique owner in Conakry using Patron on a low-end Android with spotty internet. Does this feature make their day easier or add confusion? Would they notice it at all?

**Tech critic** — Review the approach against Patron's architecture: Expo Router v6, Zustand stores, SECURITY DEFINER RPCs, offline SQLite queue, BIGINT cents ×100, palette tokens. Does this fit cleanly? Does it require a new pattern that will be hard to maintain?

**Scope guard** — Is this the simplest version that solves the problem? Are we over-engineering? Could a one-line change or a single new column handle this instead of a new screen + store + migration?

**Judge** — Synthesize all four lenses. Give:
- **Verdict**: `GREEN LIGHT` / `RESHAPE` / `KILL`
- **One-line reason** (no hedging)
- **If RESHAPE**: the minimum change that makes this worth building
- **48-hour test**: the cheapest way to validate before writing code (a dummy screen, a manual DB query, showing a wireframe to a test user, etc.)

## Output format

```
VERDICT: [GREEN LIGHT / RESHAPE / KILL]

One-line: [direct statement]

Contrarian: [finding]
User advocate: [finding]
Tech critic: [finding]  
Scope guard: [finding]

[If RESHAPE] → Minimum viable version: [description]

48-hour test: [specific action]
```

## Ground rules

- Do not start building anything during this skill. Roast only.
- Be direct. "This is a good idea but..." is sycophancy. State the verdict first.
- If the verdict is GREEN LIGHT, still note the top risk to watch during implementation.
