# Story Backlog — Key Doctor

## Epics

(One short paragraph per epic: link to its stories, governing PRD entry, current status.)

**Library** (`docs/stories/epics/library/`): the pure `packages/key-doctor` library that every surface reuses. Governing entries: `docs/final-idea.md` §13.3 phases GĐ1, GĐ2 and GĐ5, with the §4 contracts and §5 rules. Stories: [gd1-scan](epics/library/gd1-scan/overview.md) (done 2026-10-29). GĐ1 is "built" when slices S1 to S4 meet their ACs. It is "done" only after the owner records the live-run checklist in `packages/key-doctor/fixtures/README.md` (decision 0001).

## Build Order (as of 2026-10-29)

Next steps from `docs/final-idea.md` §13.3 and the current repo state. Critical path: GĐ0 → 1 → 3 → 4 → 5 → 6.

Current state:
- GĐ0 is done (moved from npm to pnpm workspaces on 2026-10-29).
- GĐ2 is done (`packages/key-doctor/test/diff.test.ts`).
- GĐ1 is done: the live-run checklist was recorded on 2026-10-29.
- GĐ7 is built. It is not deployed yet.

| Step | Phase | Work | Why now / gate |
|---|---|---|---|
| 1 | GĐ2 ✅ | `diffReports`, `toSummary` (pure, tests for every §4.3 case) | Done 2026-10-29 |
| 2 | GĐ5 | `checkProposals` + `get_proposal` fixture tests | Depends only on GĐ1; core of the main demo scene |
| 3 | GĐ3 | Worker: MCP `diagnose`, `compare`, Bearer auth, D1 `snapshots` | Critical path |
| 4 | GĐ4 | Bot: webhook, `/check`, `/changes`, `/watch`, `/unwatch`, `/list`, `/help`, `subscriptions` | Critical path. **Checkpoint 5/11:** GĐ1–4 must run end to end |
| 5 | GĐ6 | Proposal-watch job (15 min), `proposal_state`, `alerts_sent`, `/run-check`, `scripts/demo-testnet` | Main demo scene. **Milestone 8/11:** if it does not run, stop everything else |
| 6 | GĐ7 close-out | Deploy to Pages; check that the dashboard report matches `/check` | Needs GĐ4 |
| 7 | GĐ8 | Cleanup plan, Delete / Revoke through Meteor | Blocked on the §13.5 wallet-selector + Meteor signing test |
| 8 | GĐ9 | Daily key diff job (02:00 UTC) | Needs GĐ3, GĐ4 |
| 9 | GĐ10 | Network stats + reproduce script | Can run in the background any time; finish before 10/11 |
| 10 | GĐ11 → GĐ13 → GĐ12 | P1: history replay, NearBlocks key dates, watch-link | Cut order if late: GĐ11 → GĐ13 → GĐ12 → GĐ9 |
| 11 | GĐ14 | README, video, submission | Last; never cut |

Owner-only tasks that block steps above:
- Create `@KeyDoctorOnCallBot`, the Cloudflare account and D1. Steps 3 and 4 need them.
- Run the wallet-selector + Meteor signing test. It decides the scope of step 7.

## Selected Stories

| Story | Description | Lane | Status |
|---|---|---|---|
| [gd1-scan](epics/library/gd1-scan/overview.md) | GĐ1 scan library: `rpc.ts`, `scanAccount`, `scanDao`, the 13 rules of §5.1, `messages`, rule corpus, live-run script. "Built" after S1 to S4. "Done" only after the owner records the live-run checklist. | high-risk | done |
| GĐ7 dashboard (no packet) | `apps/dashboard`: check form, council report, account profile, MVP Telegram alerts dialog, scanning and error states, phone layouts. Built and tested on fixture data (unit tests, plus a browser run with RPC stubbed from the fixtures). Not done yet: deploy to Pages, check that a live testnet DAO matches `/check` (needs GĐ4), and network stats (GĐ10). Members do not appear one by one, because `scanDao` has no progress callback. | normal | built |
| GĐ8 cleanup plan (no packet yet) | UC8 key cleanup plan with Delete / Revoke through Meteor (`docs/design/dashboard` screens 4, 6, 7). Owner answers of 2026-10-29: the ML-DSA backup warning shows only once an ML-DSA key exists. The dashboard detects ML-DSA signing from chain data. App keys use "Revoke" and full-access keys use "Delete". Blocked on the §13.5 wallet-selector + Meteor signing test. | lane unchecked | planned |

## How to Add a Story

1. Create a file in `docs/stories/epics/<epic>/<story>.md` using `docs/templates/story.md`.
2. Add a row to the table above.
3. Add a row to `docs/TEST_MATRIX.md`.
4. For high-risk stories, use the 4-file folder template in `docs/templates/high-risk-story/`.

## Lane Definitions

- **Tiny**: single file, no schema changes, reversible, no test matrix update needed.
- **Normal**: up to 5 files, schema changes possible, needs test matrix updates.
- **High-risk**: cross-cutting, irreversible, security-sensitive, needs 4-file story + design review.
