---
name: session-handoff
description: Write a structured summary of the current session before clearing context. Captures what was built, files changed, open decisions, and exactly where to pick up — so the next session starts clean without losing anything.
---

# Session Handoff

Run this before `/clear` when the context is getting long or you're switching to a new task. Copy the output, clear the context, paste it in — and continue without losing anything.

## When to use

- Context window is filling up (above ~25% on the status line)
- Switching from one major task to another
- Ending a session and coming back later
- Handing off to a fresh Claude instance

## What to produce

Read the conversation history and current file state, then write a handoff document with these sections:

---

### SESSION HANDOFF

**What we were doing**
[1-3 sentences. The task in plain terms — not "we refactored X" but "we added expense categories so the Dépenses screen can filter by type."]

**Decisions locked** (don't re-litigate these)
- [Decision 1: what and why in one line]
- [Decision 2: ...]

**What shipped** (completed and verified)
- [Item 1 — file path if relevant]
- [Item 2 — ...]

**Key files to know about**
- `path/to/file.tsx` — [what it does / why it matters right now]
- `db/migration_vXX.sql` — [what it changes]
- [etc.]

**Open / in progress**
- [Thing that was started but not finished]
- [Thing that was decided but not implemented yet]

**Open questions / decisions needed**
- [Question the user needs to answer before we can proceed]
- [Uncertainty in the design that wasn't resolved]

**Known issues**
- [Bug or edge case discovered but not fixed yet]
- [TS error left open, if any]

**Pick up here**
[One clear sentence or short list: the exact next action to take in the new session. Specific enough that you don't need to re-read anything to start.]

---

## Rules

- Be specific about file paths — `stores/expenses.ts` not "the expenses store"
- Migration versions matter — always write `db/migration_v72.sql`, not "the new migration"
- Don't summarize things that are already in CLAUDE.md — the next session will load that automatically
- Keep it under 400 words so it fits cleanly at the top of a new context
- After writing the handoff, remind the user: copy this, then run `/clear`, then paste it in
