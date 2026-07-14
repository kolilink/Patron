---
name: storm-research
description: Turns one research topic into a verified, multi-perspective HTML briefing. Simulates 5-6 expert lenses on the topic, maps where they contradict each other, synthesizes into a single self-contained HTML report, then adversarially peer-reviews and verifies every citation before delivering. Use for high-stakes strategic decisions (pricing, market entry, architecture bets) where a single research pass would have blind spots.
---

# Storm Research

Multi-perspective research pipeline modeled on Stanford's STORM method: instead of one research pass with one set of blind spots, run several independent "expert lenses" in parallel, find where they disagree, then verify the survivors against primary sources.

## When to use

Trigger for decisions that are expensive to get wrong and where intuition alone is risky:
- Pricing / monetization / paywall design
- Market entry or audience segmentation calls
- Build-vs-buy or major architecture bets
- Anything where the user explicitly asks for "storm research" or a "council" / multi-perspective deep dive

Don't use this for quick factual lookups — that's a plain WebSearch. This is for decisions, not facts.

## Phase 0 — Scope the topic

Before spinning anything up, nail down in 1-2 lines each:
- **The decision** this research will inform (not just the topic — the actual choice the user is about to make)
- **The reader** — who consumes this and what they already know (skip background they already have)
- **Constraints** — budget, timeline, market, anything that rules options out before research even starts

If the user's prompt is vague, ask up to 3 questions before proceeding. If they've already given enough (a clear topic + business context), skip straight to Phase 1.

## Phase 1 — Spin up the lenses (parallel)

Default five lenses, adapted to the topic:

- **Practitioner** — Someone who has actually shipped this kind of decision before. Wants tactics, benchmarks, what worked/failed in practice. Cites case studies and operator playbooks, not theory.
- **Academic** — Pulls from peer-reviewed research and established frameworks (behavioral economics, pricing psychology, market studies). Distrusts anecdote; wants the studies behind the claims.
- **Skeptic** — Actively tries to break the obvious answer. Where does the conventional wisdom fail for this specific audience/market/constraint? What's the failure mode nobody's mentioning?
- **Economist** — Unit economics. Real numbers: costs, realistic willingness-to-pay, market size, comparable benchmarks. Distrusts vibes, wants the math to pencil out.
- **Historian** — How did comparable situations play out elsewhere, over time? What patterns repeat? Pulls precedent and analogues.

**Always check if a 6th domain-specific lens is missing** — e.g. a local-market/regulatory specialist when the topic has a geography most lenses won't naturally cover, or a frontline-user lens when all five lenses default to looking from the owner's chair. Add it if the topic needs it; say explicitly which gap it fills.

Launch each lens as a parallel subagent (Agent tool, general-purpose, run independently — they do NOT talk to each other in this phase). Each lens should:
1. Research the topic from its specific angle, using WebSearch/WebFetch for current information — do not rely on training-data assumptions for anything that changes over time (pricing, vendor support, market conditions).
2. Cite sources (URLs) for every concrete claim, stat, or benchmark.
3. Return: top 3-5 findings, each tagged with confidence (high/medium/low) and source.

## Phase 2 — Contradiction map

Once all lenses report back, compare their findings yourself (no subagent needed for this step — it's synthesis, not research):
- Where do two or more lenses agree? → high-confidence finding
- Where do lenses directly contradict each other? → flag it, note which lens has stronger evidence and why
- What's the **missing lens** — the angle none of them covered? (e.g., all five look from the owner's chair, none from the end customer's)

## Phase 3 — Synthesize

Write the report using `references/report-template.html` as the structural base:
- 60-second summary up top
- Key findings ranked by reliability (high/medium/low), each tagged with which lenses supported it and which challenged it
- Contradictions section — show the disagreement, not just the resolution
- Missing-lens callout if Phase 1 found one
- Practical, tailored takeaways for the reader's actual decision (not generic stats — translate findings into "what to do given your constraints")

## Phase 4 — Adversarial peer review + verification

Before delivering, run one more pass (can be a subagent or done directly if the report is small):
- For every concrete claim/stat in the draft, re-check it against its cited source.
- Mark each as **Confirmed** / **Corrected** (number or framing was off, fixed) / **Demoted** (couldn't verify — downgrade confidence or cut it).
- Append a sources table at the bottom of the report showing this verification status per source.

This is the step that separates this from a single-pass research dump — don't skip it even under time pressure. A confident-sounding wrong number is worse than no number.

## Output

- Save the final report as a self-contained HTML file (inline CSS, no external deps) so it opens standalone in a browser.
- Tell the user where the file is and give a 3-5 sentence spoken summary of the verdict — don't make them open the file to get the headline.
- If a finding directly contradicts something the user currently believes or has already built, say so plainly up front rather than burying it.

## Ground rules

- Don't skip verification to save time — an unverified stat presented as fact is the exact failure mode this skill exists to prevent.
- Don't pad lenses with generic filler — if a lens has nothing new to add for this topic, say so briefly rather than forcing 5 findings.
- Tailor every report to the reader's actual business/constraints given in Phase 0 — this is not a generic market report, it's a decision-support document for one specific reader.
