# Story Backlog — Key Doctor

## Epics

(One short paragraph per epic: link to its stories, governing PRD entry, current status.)

**Library** (`docs/stories/epics/library/`): the pure `packages/key-doctor` library that every surface reuses. Governing entries: `docs/final-idea.md` §13.3 phases GĐ1, GĐ2 and GĐ5, with the §4 contracts and §5 rules. Stories: [gd1-scan](epics/library/gd1-scan/overview.md) (done 2026-10-29). GĐ1 is "built" when slices S1 to S4 meet their ACs. It is "done" only after the owner records the live-run checklist in `packages/key-doctor/fixtures/README.md` (decision 0001).

## Build Order (as of 2026-10-30)

Next steps from `docs/final-idea.md` §13.3 and the current repo state. Critical path: GĐ0 → 1 → 3 → 4 → 5 → 6.

Current state:
- GĐ0 is done (moved from npm to pnpm workspaces on 2026-10-29).
- GĐ2 is done (`packages/key-doctor/test/diff.test.ts`).
- GĐ3 is built (`apps/worker`, `test/mcp.test.ts`). It is done after deploy.
- GĐ4 is built (`apps/worker/src/telegram`, `test/telegram.test.ts`). It is done after deploy and a real group test.
- GĐ6 and GĐ9 are built (`apps/worker/src/jobs`, `test/jobs.test.ts`, `scripts/demo-testnet/demo.sh`). They are done after the live demo run.
- GĐ5 is built (`packages/key-doctor/test/proposals.test.ts`). It is done once the owner checks the four Sputnik facts in `fixtures/README.md` on a testnet DAO.
- GĐ1 is done: the live-run checklist was recorded on 2026-10-29.
- GĐ7 is built and deployed to Pages (`https://key-doctor-dashboard.pages.dev`); the Worker, D1 and the Telegram webhook are live too (O1 done on 2026-10-30, `pnpm deploy:all`).
- GĐ6 live run on 2026-10-30: voter-key alert and governance alert both reached the group, and the second `run-check` did not repeat the first alert. Details: `docs/demo-testnet-run-2026-10-30.md`.

| Step | Phase | Work | Why now / gate |
|---|---|---|---|
| 1 | GĐ2 ✅ | `diffReports`, `toSummary` (pure, tests for every §4.3 case) | Done 2026-10-29 |
| 2 | GĐ5 🔨 | `checkProposals` + `get_proposal` fixture tests | Built 2026-10-29; done after the GĐ5 live-run list in `fixtures/README.md` |
| 3 | GĐ3 🔨 | Worker: MCP `diagnose`, `compare`, Bearer auth, D1 `snapshots` | Built 2026-10-29 (local workerd run OK). Done after deploy plus a live `curl` and Claude Code call |
| 4 | GĐ4 🔨 | Bot: webhook, `/check`, `/changes`, `/watch`, `/unwatch`, `/list`, `/help`, `subscriptions` | Built 2026-10-29. Done after deploy plus a group test. **Checkpoint 5/11:** GĐ1–4 must run end to end |
| 5 | GĐ6 🔨 | Proposal-watch job (15 min), `proposal_state`, `alerts_sent`, `/run-check`, `scripts/demo-testnet` | Built 2026-10-29. Done after the demo runs end to end on testnet. **Milestone 8/11:** if it does not run, stop everything else |
| 6 | GĐ7 close-out | Deploy to Pages; check that the dashboard report matches `/check` | Needs GĐ4 |
| 7 | GĐ8 🔨 | Cleanup plan, Delete / Revoke through Meteor | Plan page and delete guards built 2026-10-29. Revoke / Delete buttons built 2026-10-30; Verified on testnet 2026-10-30 with a real Meteor account: Revoke of function-call keys (one, and two `DeleteKey` in one transaction) and Delete of a full-access key, each key gone on chain. Per-key buttons only, no bulk delete (O5 done) |
| 8 | GĐ9 🔨 | Daily key diff job (02:00 UTC) | Built 2026-10-29 with GĐ6 (shared delivery). Done after deploy |
| 9 | GĐ10 🔨 | Network stats + reproduce script | Built 2026-10-29 (`pnpm stats`). Done after the owner runs it and the table goes into the README |
| 10 | GĐ11 → GĐ13 → GĐ12 | P1: history replay, NearBlocks key dates, watch-link | GĐ12 built 2026-10-29. GĐ11 and GĐ13 need NearBlocks and live RPC. Cut order if late: GĐ11 → GĐ13 → GĐ12 → GĐ9 |
| 11 | GĐ14 | README, video, submission | Last; never cut |

Open question for the owner (2026-10-29): `/changes` and MCP `compare` on a target with no baseline save one as the first baseline (`docs/final-idea.md` §8.3, UC3). CLAUDE.md names only the daily job and the first subscription as baseline writers. The code follows the spec, and snapshots are pruned to 7 per target. Should `/changes` for an unwatched target answer "no baseline yet" without writing instead?

### Owner tasks (human only)

Tick each box when done and tell Claude the result (numbers, names, block heights) so it can record it.

- [x] **O1 Deploy.** Done 2026-10-30 (D1, Worker, webhook and Pages are live; the dashboard-vs-`/check` comparison, `/list` and `/unwatch` checks, and an MCP `diagnose` curl are still open). Create `@KeyDoctorOnCallBot` (BotFather), the Cloudflare account and D1, then follow README "Deploy": `wrangler d1 create key-doctor`, put the id in `apps/worker/wrangler.toml`, `pnpm --filter worker db:migrate:remote`, `wrangler secret put` for the four secrets, `pnpm --filter worker deploy`, `setWebhook`, and Pages for the dashboard. Unblocks steps 3, 4, 6, 8 and GĐ12.
- [~] **O2 Demo run.** Ran 2026-10-30 on `kdd1793327513.sputnik-v2.testnet` with existing old accounts (PR #14). New neutral set `kdoncall*` created the same day: `compromise`, `vote` and the alert steps wait until 2026-11-01 (first keys are "new" for 48 hours): steps `dao` to the second `run-check` passed. Left: the Meteor revoke test and key cleanup on `bot1`/`test1`. Run `scripts/demo-testnet/demo.sh` on testnet. Create the accounts at least 48 hours before (see the script header). Unblocks step 5 (milestone 8/11).
- [x] **O3 GĐ5 live check.** Done 2026-10-29: facts 1 and 2 confirmed, 3 and 4 partly (see `fixtures/README.md`). Check the four Sputnik proposal facts in `packages/key-doctor/fixtures/README.md` ("GĐ5 live-run checklist").
- [ ] **O4 Stats.** Run `pnpm stats` (mainnet, live RPC; it takes a while). Paste `data/network-stats.md` into the README and commit `data/network-stats.json`.
- [x] **O5 Meteor signing test** (passed 2026-10-30: several `DeleteKey` in one transaction and a full-access `DeleteKey` both sign; the wallet does not say which key it signs with, so the dashboard keeps two full-access keys.) (§13.5): does Meteor through wallet-selector sign several `DeleteKey` actions in one transaction, and a `DeleteKey` for a full-access key? Does it say which key it signs with? Decides the rest of step 7.
- [ ] **O6 Decide** the open question above (does `/changes` write a first baseline?).
- [ ] **O7 Submission** (GĐ14, `docs/near-hackathon.md` §9.3): make the repo public, record the demo video, post on X ("built at NEAR HACKATHON"), create the mainnet prize account, and submit the form once. Do these only by hand; Claude never does them.

### Claude tasks (next sessions)

- [x] **C1** Done 2026-10-30: dashboard chips and README examples use the neutral demo set `kdoncall-{a,b,c}.testnet` (council), DAO `kdoncall.sputnik-v2.testnet` and cleanup account `kdoncall-p.testnet` (created 2026-10-30 with 3 full-access and 2 function-call keys); the demo DAO council was later grown to 11 members (`kdpg347643-3..10` added by vote) so member paging shows, and transfers now need 6 of 11 votes; the README has a Live demo section with the Pages URLs.
- [ ] **C2** after O3: record the results and fix `packages/key-doctor/src/proposals.ts` if any fact differs.
- [ ] **C3** after O4: put the stats table into the README "The problem" section.
- [x] **C4** GĐ8 in-dashboard signing built and verified on testnet 2026-10-30 (per-key Revoke / Delete buttons, wallet SDK lazy-loaded, multi-key and full-access Delete pass, O5). Original scope: in-dashboard signing with wallet-selector + Meteor, using `buildDeletePlan` in `apps/dashboard/src/cleanup.ts` (no `signIn` with `contractId`).
- [ ] **C5** P1, optional: GĐ13 (NearBlocks key dates), then GĐ11 (history backtest, `docs/final-idea.md` §14.1). Both need NearBlocks API access.
- [x] **C7** (done 2026-10-30; bot `/check` stays unchanged: a chat message is too small for a list, so the list is dashboard only) owner request 2026-10-30: show the DAO's proposal list (id, kind, status, who voted) in the dashboard DAO report. A DAO scan shows keys and voting rules only today; proposals appear only as alerts from `checkProposals`. Read `get_proposals` in the browser through the library (new export) so `kd.report.v1` does not change; decide first whether the bot `/check` shows it too. Source: `docs/final-idea.md` §14.1 data table.
- [x] **C8** MCP parity with the dashboard (2026-10-30): tools `list_keys` and `list_proposals` added to `/mcp`, read-only, tests in `apps/worker/test/mcp.test.ts`. Not yet run against the deployed Worker or from Claude Code / Codex. Not added: the cleanup plan (it is built in the dashboard from `Member`; an agent gets the same data from `list_keys`). The NEAR AI chat idea (with a daily free quota and a paid Pro tier) is pending and conflicts with the "No LLM in the product" invariant, which the owner has not changed.
- [ ] **C6** last: a final README pass so every claim matches what is deployed (GĐ14).

### How to resume in a new session

1. `git pull` on `main`, `corepack enable`, `pnpm install`, then `pnpm test`. All three packages should print `# fail 0`.
2. Read this file (state, owner and Claude tasks), then `docs/TEST_MATRIX.md` for the proof per phase. Commit messages say what each phase still misses.
3. Tell Claude which owner tasks are done and paste their results. Claude picks up the matching C-task.

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
