# Backward transitions (refuse to advance on an upstream defect)

The phases run forward 1→6. A gate that finds a defect from an **earlier** phase routes back. It does not patch forward. Core rule: **never advance past a gate with a known upstream defect.** Fix the defect at the lowest phase that owns the root cause. Then **run every gate again between that phase and where you were**, because a fix makes the downstream proofs stale. Always separate *design wrong* (the spec or ADR is the problem: Phase 2) from *code wrong* (the implementation is the problem: Phase 3).

| A gate finds… | Root cause | Route back to | Then re-run |
|---|---|---|---|
| Phase 3 (Implementation) — the design can't be built as specified | design | **Phase 2** (Lead Dev ⇄ PO): revise design + ADR/story before continuing | 2.7 → 2.5 → 3 → … |
| Phase 3.6 (Testing) — a failing test exposes a logic/code bug | code | **Phase 3** (owning builder) | 3.5 → 3.6 |
| Phase 3.6 (Testing) — the behaviour is wrong *as designed* (spec is the bug) | design | **Phase 2**: update the decision, then plan the proof again | 2.7 → 2.5 → 3 → 3.5 → 3.6 |
| Phase 3.7 (Security review) — a vuln / missing authz / cross-tenant leak / SSRF gap | code | **Phase 3** (`security-coder` or owning builder) | 3.6 → 3.7 |
| Phase 3.8 (SQL Pro) — N+1, missing index, correlated subquery, a raw query missing the tenant predicate, perf regression | code | **Phase 3** (`sql-pro` or backend builder) | 3.6 → 3.8 |
| Phase 4 (Code review) — a blocking issue | code → **Phase 3**, design → **Phase 2** | whichever owns it | the gates between (3.5–3.8) → 4 |
| Any phase — requirements are ambiguous or wrong | requirements | **Phase 1** (PO): re-clarify the story, update `docs.stories` + the PRD issue | 2 → … |
| Any phase — the owner changes scope mid-flow | design | **Phase 2** (Lead Dev delta) | 2.7 (PO + red-team score, or the user's skip). Then 2.5 packet ACs → 3 → … → 4. The proof verdict runs after kestrel. |

Record the bounce in the story packet (what gate caught it, where it routed, what re-ran) so the loop's history stays honest. Do not mark a story green until it has passed *forward* through every gate without a backward bounce.

**Termination: a bounce must converge, never spin.** Two guards bound it:

- **Monotonic progress.** Every bounce changes a recorded artifact: a decision or ADR (design bounce), code (code bounce), or proof (test bounce). A gate run against an unchanged state is a no-op bounce. Stop and treat it as a process bug, not a retry.
- **Loop cap.** Each gate gets 2 fix rounds. A third round asks the user. The packet tracks two counters per story, and the cap applies to each:
  - (a) how many times the **same gate** rejected the story for the **same root cause**,
  - (b) how many times a defect crossed the **Phase 2 ⇄ Phase 3** boundary.

  When counter (b) trips, the requirement is almost always the real defect: design and code keep blaming each other. The Lead Dev takes it to the user with what keeps failing, the two candidate root causes and a recommendation. The user breaks the tie: revise the requirement at Phase 1, accept a scoped limitation, or split the story.

`references/metrics.md` reads these counters (`bounce_2x3` is counter b).
