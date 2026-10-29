# PRD — Product Source of Truth

Specs live in this repo, in Vietnamese. Read them before turning any prompt into work. The profile (`.claude/dev-team.md`) key `prd` names the location.

- **Location**: `docs/final-idea.md` (canonical), then `docs/usecase.md`. On conflict: `docs/final-idea.md` > `docs/usecase.md` > `proposal-key-doctor.md` (v2, not in the repo).
- **Overview**: `docs/final-idea.md` §0 (one-page summary). Contest rules and submission checklist: `docs/near-hackathon.md`.

## Issue hierarchy

The PRD is a single document set, not an issue tracker.

| Type | What it is |
|---|---|
| Use case (UC1–UC8) | A user-facing flow: `docs/final-idea.md` §2, detailed in `docs/usecase.md` |
| Phase (GĐ0–GĐ14) | A build slice with dependencies and a "Xong khi" (done when) criterion: `docs/final-idea.md` §13.3 |
| Contract / rule | Data contracts (§4), rules (§5), Worker endpoints and jobs (§8), bot messages (§9) |

Every task in this repo must trace to a phase in §13.3 and, where it applies, to a use case, contract or rule section. A change with no governing entry is either a harness improvement or needs one added first.

---

## PRD Gate

**Check the PRD before you write code, not after.** This is step 1 of the `AGENTS.md` task loop.

### 1. Find the governing entry

Find the phase in `docs/final-idea.md` §13.3, then the sections it touches (§4 contracts, §5 rules, §8 Worker, §9 bot, §10 dashboard) and the matching UC in `docs/usecase.md`. Search with `grep -n "<keyword>" docs/final-idea.md docs/usecase.md`.

### 2. If no governing entry exists

| Situation | Do this |
|---|---|
| Harness improvement (docs, templates, process, CI) | No PRD entry needed. Proceed. |
| The phase exists, but the detail is missing | Propose the addition to the user, then implement. Note it in the story packet. |
| No phase covers it | Stop and ask. A new phase or use case is a product decision. Do not invent one. |

### 3. If the entry is wrong or out of date

The spec files are human-authored. Do not rewrite their content: tell the user the corrected text and note it in the story packet. Marking a phase done in §13.3 / §13.5 is allowed (required by `CLAUDE.md`).

### 4. Before the PR merges

The governing section must describe what shipped. Contract changes bump `schema_version` and are called out in the commit message.

## Current pillars / milestones

- Critical path: GĐ0 → 1 → 3 → 4 → 5 → 6 (GĐ6 is the main demo scene). Checkpoints: 5/11 (GĐ1–4 end to end), 8/11 (GĐ6 running).
- Deadline: 14/11/2026 23:59 UTC.
