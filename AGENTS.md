# Agent Operating Guide — Key Doctor

## Source Of Truth

Read in this order:

1. `README.md` for project status.
2. `docs/PRD.md` — where product requirements live. Every task traces to a governing requirement there.
3. `docs/HARNESS.md` for the operating model.
4. `docs/FEATURE_INTAKE.md` before turning any prompt into work.
5. The user-provided spec or prompt, when one exists.
6. `docs/ARCHITECTURE.md` before proposing implementation shape.
7. `docs/CODING_RULES.md` before editing source code.
8. `docs/stories/` for story packets and backlog.
9. `docs/TEST_MATRIX.md` for proof status.
10. `docs/decisions/` for why important choices were made.

## Task Loop

For every task:

1. **Check the PRD first — before any code.** Locate the governing requirement per `docs/PRD.md` § PRD Gate. Do not open an editor until you have found it, filed it, or established that the work is a harness improvement (which needs none).
2. Classify the request with `docs/FEATURE_INTAKE.md`.
3. Identify whether the input is a new spec, spec slice, change request, new initiative, maintenance request, or harness improvement.
4. Locate the affected product docs and story files. A design handoff, mockup, or spec artifact named in the prompt is an **input to intake, not a substitute for it** — search `docs/stories/` for an existing packet before deriving one from the artifact.
5. Check `docs/TEST_MATRIX.md` for existing proof and gaps.
6. If the plan builds on a dated evidence artifact (a spike comment, audit, benchmark): list the
   changes merged since the artifact's date and re-check every load-bearing number before finalizing.
   Acceptance criteria against live data must be invariants or bands — never point-equality with
   a dated measurement, which fails correct code once the data drifts.
7. Work only inside the selected lane: tiny, normal, or high-risk.
8. Before finishing, ask:
   - **Did the governing PRD requirement drift from what shipped?** If so, update it — see Done Definition.
   - Did product truth change?
   - Did validation expectations change?
   - Did architecture rules change?
   - Did coding rules or tooling expectations change?
   - Did we discover a repeated failure pattern?
   - Did the next agent need a clearer instruction?
   - Did a state, status, enum, query, or filter change need backward compatibility?
9. Update routine harness files directly, or add a proposal to `docs/HARNESS_BACKLOG.md` when the change is structural.

## Harness Change Policy

Agents may update directly:

- Story status and evidence.
- `docs/TEST_MATRIX.md` rows.
- Links from story packets to product docs.
- Validation notes and reports.
- Small clarifications tied to the current task.
- PRD entries the agent itself authored.

Agents should ask for human confirmation before:

- Changing architecture direction.
- Removing validation requirements.
- Changing the source-of-truth hierarchy.
- Changing risk classification rules.
- Replacing the feature workflow.
- Editing the body of a human-authored PRD entry. Comment with the corrected text; never silently rewrite a product owner's spec.

## Branch Flow

```
feature/* ──► main
```

1. Branch every feature from `main`.
2. Loop inside the feature branch: discuss → implement → review → fix → done.
3. When done, open PR `feature/* → main`. After review + merge, the feature is integrated.
4. **Right after the merge, settle the PRD.** Re-read the governing requirement's acceptance
   criteria against what shipped and comment the evidence (the merged PRs) on it.

Rules:

- `main` is the deploy branch. No other long-lived branches; agent sessions work on `claude/*` branches.
- Verify locally (typecheck, tests, lint) on the feature branch before opening the PR.
- Hotfix: same flow — branch from `main`, PR back to it.
- Never push directly to `main`. Always via PR.

## Done Definition

A task is done only when:

- The requested change is completed or the blocker is documented.
- **The governing PRD requirement matches what shipped.** Any change that alters observable behavior updates — or files — its requirement before the PR merges. A PR whose behavior the PRD does not describe is not done.
- Relevant docs, stories, and test matrix entries remain current.
- Source-code changes follow `docs/CODING_RULES.md`.
- Validation commands were run when they exist.
- Observable behavior was run on the local stack (the profile's `verify_skill`, when set), or the evidence row says `NOT RUN — <reason>`.
- Missing harness capabilities were added to `docs/HARNESS_BACKLOG.md`.
- The final response says what changed and what was not attempted.
