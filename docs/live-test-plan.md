# Test plan: every feature, before the 2026-11-14 deadline

Written 2026-11-09 on `main` at `a9eae69`. Testnet only. Each row says what to do, what you should see, who runs it and what it needs. Anything that signs a transaction or uses a secret is the owner's (CLAUDE.md invariants). Claude runs the rest and records evidence.

Record each result in [TEST_MATRIX.md](TEST_MATRIX.md) (Evidence Format) or the backlog, with the date, tx hash or block height, and the exact output. A row that was not run stays "not run". It is never marked as passed.

## 0. Before you start

| Need | For | Lead time |
|---|---|---|
| `scripts/demo-testnet/demo.sh accounts` (members a, b, c) | L1, L2, B5 | **48 h** before `compromise`: a faucet account's first key counts as a new full-access key for 48 h. Run it on 2026-11-09 or 11-10. The last safe start is 2026-11-12 20:00 UTC |
| `RUN_CHECK_TOKEN`, `KD_WORKER_URL=https://key-doctor.duonghb53.workers.dev` | L1, L2, W2–W5 | none. The token is a secret, so the owner runs every `/run-check` |
| A Telegram group with `@KeyDoctorOnCallBot`, and a private chat with it | B1–B8 | none |
| Meteor, Here and HOT testnet wallets with about 10 NEAR each | D4–D10 | none |
| `usdc.fakes.testnet` minted to a DAO (anyone may `mint`) | Y1–Y4 | none |
| `NEAR_AI_API_KEY` | Y5, Y6 | none |
| `near` (near-cli-rs), node 22.18 or newer, Rust with `cargo near` | A3, L1, Y1 | none |

## 1. Automated suites (Claude, any time, rerun before every merge)

| # | Do | See | Last result |
|---|---|---|---|
| A1 | `pnpm test` | 5 packages, fail 0 | 2026-11-10: 1,159 tests (key-doctor 492, dashboard 452, worker 155, guard-mcp 52, near-ai-agent 8), fail 0, skip 0 |
| A2 | `pnpm typecheck` | no errors | 2026-11-09: exit 0 |
| A3 | `pnpm test:guard` | Guard 130 unit + 24 sandbox, factory 18 unit + 12 sandbox, all pass | 2026-11-10: pass (Guard 153 unit + 24 sandbox + 3 DCA sandbox, factory 25 + 16) |
| A4 | `pnpm --filter dashboard build` | `dist/` builds with no error | 2026-11-09: builds with no error |

## 2. Hosted MCP (Claude, read only, no secret)

Call `https://key-doctor.duonghb53.workers.dev/mcp` with a JSON-RPC body (node `fetch`, not curl through rtk). The limit is 30 calls a minute per IP.

| # | Tool | Do | See | Result (2026-11-09) |
|---|---|---|---|---|
| M1 | `initialize`, `tools/list` | list the tools | 7 tools: `diagnose`, `compare`, `list_keys`, `list_proposals`, `watch`, `preflight`, `yield_suggestions` | pass: `key-doctor` 0.1.0, protocol `2025-03-26`, the 7 tools |
| M2 | `diagnose` | `kdoncall.sputnik-v2.testnet`, summary, then full report | `kd.report_summary.v1`, then `kd.report.v1` with ruleset `2026-11-03`. D1 is not written | pass: summary, then full report, ruleset `2026-11-03`, 12 members, 0 member errors |
| M3 | `diagnose` | an account that does not exist | `isError` with `kd.error.v1` `NOT_FOUND` | pass: `isError`, `NOT_FOUND` |
| M4 | `compare` | the same target twice | the first call stores a baseline. The second gives the same `changes`, and the baseline does not move | pass: both calls `from` block 276712263, 0 changes, baseline unchanged |
| M5 | `list_keys` | `kdoncall-p.testnet` | its keys, each with its age from the nonce | pass: 5 keys with ages |
| M6 | `list_proposals` | `kdoncall.sputnik-v2.testnet` | the latest proposals with their kind and status | pass: latest #15, Approved |
| M7 | `preflight` | `kdoncall-p.testnet` | `allow` or `review` with reasons. A `block` case is L2 | pass: `review`, reasons FA_MULTIPLE, KEY_UNUSED ×4, FC_ANY_METHOD ×2 (all cleanup) |
| M8 | `watch` | a bad target | refused without writing. A real `watch` writes a subscription, so it belongs to the owner in B6 | pass: `INVALID_TARGET`, nothing written |
| M9 | `yield_suggestions` | a DAO with no token | an empty list with its reason, ruleset `2026-11-08` | pass on `payroll-2`: 0 suggestions, 5 notes, `errors: []`, ruleset `2026-11-08` |
| M10 | rate limit | 31 calls in one minute | the 31st is refused with `RATE_LIMITED` | pass: calls 1–30 → 200, 31–33 → 429 `RATE_LIMITED`, `retryable: true` |
| M11 | Codex as a client | owner adds the MCP URL to Codex and asks for `diagnose` | the same report as M2 (still open) | not run (owner) |

## 3. Dashboard, read only (Claude, built-in browser)

`https://key-doctor-dashboard.pages.dev`. At 1280 px and 375 px, check for no horizontal scroll and no console errors.

| # | Page | Do | See | Result (2026-11-09) |
|---|---|---|---|---|
| D1 | check | `?target=kdoncall.sputnik-v2.testnet` | members sorted high → cleanup → note → ok, each linking to `?target=<id>&from=<dao>`, and a `/watch` hint | pass: 12 members (all ok), 10 per page, `?target=<id>&from=<dao>` links, the Telegram alerts button, 16 proposals |
| D2 | check | `?target=kdoncall-p.testnet` | its keys and the cleanup plan (UC8 order) | pass: 3 full-access and 2 app keys, 4 never used; the cleanup plan and the key table |
| D3 | mcp | open it | the URL and the 7 tools, matching M1 | **fail on live**: 5 tools listed (no `preflight`, `yield_suggestions`). Fixed in PR #59 (merged), live after the next Pages deploy |
| D4 | guard | `?page=guard&dao=kdg1793607117.sputnik-v2.testnet` | the Guard card or the create form; bad input refused field by field (guard-test-guide T2) | pass: create form (no Guard yet). Each T2 bad input refused next to its field, Preview not shown. Messages are English only, while T2 asks for vi + en. A stale error stayed above the preview after a fix, fixed in PR #59 (see notes) |
| D5 | budget | open it with no wallet | the Cautious and Balanced presets and their funding minimum | pass with a note: no wallet shows the intro and Connect wallet. Cautious (1 / 5 NEAR) and Balanced (5 / 20 NEAR) are in the form that opens after connecting (read from the hidden DOM, not seen with a wallet). No funding minimum is shown before that |
| D6 | my-agents, yield | open them with no wallet | "connect a wallet" and nothing written | pass: My Agents says "Wallet not connected"; yield opens read-only; no Worker request |
| D7 | old links | `?page=oncall`, `?page=agents`, `?page=guard` with no `dao` | check with the alerts drawer open; budget with add-agent; budget | pass: `oncall` → check page with the alerts drawer open; `agents` → budget with "This link needs a Budget"; `guard` → budget |

Notes from the 2026-11-09 run:

- D4: after a refused submit, a valid one shows the preview, but the old "Fix the fields marked below." and the field error stay (`submitGuardCreate` re-rendered the form only on failure), and an invalid submit after a valid one kept the old preview and its Sign button. Both fixed in PR #59 (merged 2026-11-09, live after the next Pages deploy). The Budget form already repaints on every submit.
- D4: a whitelist cap above `max_per_tx` is accepted. T2 does not list it, so it is not counted as a failure.

## 4. Live flows (owner signs, Claude reads the chain and records)

### Telegram bot

| # | Do | See | Status |
|---|---|---|---|
| B1 | `/check kdoncall.sputnik-v2.testnet` in private | the summary in vi and en. D1 is not written | done earlier |
| B2 | `/changes <dao>` twice | the same changes both times. The baseline does not move | done earlier |
| B3 | `/watch <dao>` in the group | a confirmation, and one row per chat and target | done earlier |
| B4 | `/list`, then `/unwatch <dao>`, then `/list` | the DAO is listed, then gone | pass 2026-11-10 (owner, live bot) |
| B5 | a plain message naming `x.testnet` in private | the same as `/check x.testnet`. In a group with no name, no reply | **open** |
| B6 | dashboard check page, **Watch in Telegram** | the link opens the bot. `/start <code>` subscribes once. The same code a second time is refused | pass 2026-11-10 (owner, `payroll-1.sputnik-v2.testnet`): the link opened the bot and the code was taken; the chat already watched the DAO, so the bot replied "This chat already watches payroll-1.sputnik-v2.testnet." and added no second row |
| B7 | `/yield <dao>`, `/yield_watch <dao>`, `/yield_unwatch <dao>` on a DAO from Y1 | suggestions, then a subscription, then none | `/yield` pass 2026-11-10 on `payroll-1` (0 test USDC: no suggestion, no model call) and on `kdy1794161239.sputnik-v2.testnet` (one suggestion with model reasons, see Y5). `/yield_watch` and `/yield_unwatch` still **open** |
| B8 | remove the bot from a test group that watches the demo DAO, make a new proposal, then run W2 | the send to that chat fails and its subscriptions are deleted | **open** |

### Worker jobs (`/run-check`, owner holds the token)

`curl -X POST "$KD_WORKER_URL/run-check" -H "authorization: Bearer $RUN_CHECK_TOKEN" -d '{"job":"<job>"}'`

| # | Job | See | Status |
|---|---|---|---|
| W1 | `GET /` with no token | `ok` (text/plain) | 2026-11-09: pass, 200 `ok` |
| W2 | `proposals` twice | the first run sends any new alert. The second sends nothing | done in the demo run of 2026-10-30 |
| W3 | `daily` | a diff for each watched target. Also watch the cron at 02:00 UTC (09:00 in Vietnam) once | cron pass 2026-11-10: D1 `snapshots` has a new baseline for each of 6 targets at 02:00:21–02:00:29 UTC, and the owner got the vi + en "Key changes today" message for `kdd1793327513.sputnik-v2.testnet` (`bot2.duonghb3.testnet`: new full-access key, several full-access keys, key never used) |
| W4 | `keeper` | `errors: []` | runs every 15 min. Steps executed on `payroll-2` (K4) |
| W5 | `yield` | a push to chats from B7 | **open** |
| W6 | `run-check` without the token | 401 | 2026-11-09: pass, 401 `UNAUTHORIZED` (no token and a wrong token) |

### Attack demo (main scene, `scripts/demo-testnet/demo.sh`)

| # | Do | See | Status |
|---|---|---|---|
| L1 | `accounts` (48 h early), `dao`, `/watch` in the group, `transfer`, `compromise`, `vote`, `run-check`, `governance`, `run-check` | a high alert naming b and c after the vote, then the governance alert. No other alerts | 2026-11-09: **pass**. Existing older accounts instead of `accounts`: a `bot2.duonghb3.testnet`, b `mk_test.duonghb3.testnet`, c `bot1.duonghb3.testnet` (`KD_DEMO_SIGN=sign-with-legacy-keychain`). DAO `kdd1794191632.sputnik-v2.testnet` (tx `61hG5DhufDppBUamuWMjUi1hEBBEEfapN5gmxE9QbkMe`). Transfer proposal 0 (tx `7CBQbaD3J9EKnQph6M6GYxa3ghL7FwQrH58nq9xYhU8Y`), new key on a at block 276861229, a's vote (tx `B9ZFmuu7v7p7ALB5J2pLnxLp3uuHvDtD4ow73rCuBSRL`), governance proposal 1 (tx `3wBVf68XVj1mcNBgYov435r8eE9AYMZ9oddA5iXHc2NE`). Telegram got two vi + en messages and nothing else: "ALERT" for proposal 0 (new full-access key less than an hour before the vote, "Votes: 1/2 approved. Still to vote: mk_test, bot1"), then "GOVERNANCE CHANGE" for proposal 1 (0/2, all three still to vote, verify with the proposer) |
| L2 | within 48 h of `compromise`, `preflight` on member a over MCP | `block`, naming the new full-access key | 2026-11-09: **pass**. Hosted MCP, block 276861528: verdict `block`, high reason `FA_RECENT` on `ed25519:5ECiGvMnr7EqyA64Fo4cydTwK2aPYpXnNeMRQUAL1wgC` (the key from `compromise`). The other reasons are cleanup only |
| L3 | after L1, `diagnose` on the demo DAO, and the dashboard check page | a's new key is flagged, and the dashboard shows the red 48 h box | 2026-11-09: **pass**. `diagnose`, block 276861526: summary `high`, 1 member high (a, `FA_RECENT` on the new key, `key_added_block` 276861229), 2 cleanup, no errors. Dashboard `?target=<dao>` lists a as "High risk, New full-access key" and both proposals with the vote counts. `?target=bot2.duonghb3.testnet` shows the red box "A full-access key was added less than an hour ago" with the key and block 276,861,229 |

### Agent Guard (v1 factory, [guard-test-guide.md](guard-test-guide.md))

| # | Do | See | Status |
|---|---|---|---|
| G1 | T3: invoices inv-001 to inv-004 through `apps/guard-mcp` | three `auto_approved`, inv-004 `pending` with three reasons, not split | done earlier |
| G2 | T4 rows 1–6: limits and the guardian pause | `OVER_PER_TX`, `OVER_DAILY_LIMIT`, `NOT_WHITELISTED`, `TOO_MANY_PENDING`, `PAUSED` | pause **open** |
| G3 | T5: **Propose a change**, **Pause now** with a non-guardian wallet, **Propose retire** | the `set_policy` proposal; the pause refused before the wallet opens; a `ChangePolicy` that removes only the Guard | pass 2026-11-10 (owner): pause and retire checked live. The Budget page's Pause / Resume buttons were renamed from "Pause all agents" / "Resume agents" to "Pause this Budget" / "Resume this Budget": `pause` stops every agent of that one Guard, not all of the owner's agents |
| G4 | T6: Telegram alerts for auto, pending and failed | the three alert kinds, then nothing new on the next run | done earlier |
| G5 | sign one Guard action with Here and one with HOT | the same result as Meteor | **open** |

### Agent Budget (v2 factory) and keeper

| # | Do | See | Status |
|---|---|---|---|
| K1 | Budget page, Cautious preset: sign 1, sign 2, download the key file | the four checks after sign 2 pass, and the key file has one function-call key limited to the Guard | done 2026-11-08 (`payroll-1`, `payroll-2`) |
| K2 | leave the page before downloading | the unsaved-key question | unit-tested; see it live on the next Budget creation |
| K3 | a DAO `FunctionCall` proposal on `payroll-1`: `create_plan` on its Guard with `Transfer` to a whitelisted receiver, `amount_per_run` ≤ `max_per_tx`, `interval_sec` ≥ 60, `runs_total` 2, `start_at` in the past; approve it | `plan_created` event, and `get_plans` shows it `Active` | done 2026-11-09 on `payroll-2` instead: plan 1 (Scheduled payout, 0.1 NEAR × 3) from the dashboard; plan 2 (DCA) on 2026-11-09 too (backlog O9) |
| K4 | wait for the keeper (minutes 7, 22, 37, 52) or run W4 | `execute_plan_step` from `keydoctor-keeper.testnet`, the receiver paid, `runs_done` 1, then 2 on the next cycle, and nothing after | done 2026-11-09 on `payroll-2`: the keeper ran plan 1 to `completed` (3 runs) and DCA plan 2 to `completed` (2 sells, tx hashes in backlog O9) |
| K5 | guardian `pause` on a Budget | one `budget_owner_action` message in its chats on the next keeper cycle | **open** |
| K6 | My Agents page with the owner wallet | `payroll-1` and `payroll-2` with their plan and limits | **open** |
| K7 | `scripts/guard-setup/factory-global.sh keydoctor-guards-v2.testnet --send`, then step 1 of Create on the live Budget page; then create one Budget | `kd_factory_metadata.guard_code_global` true; the Guard cost line about 0.01 NEAR; the new Guard has no code of its own (`code_hash` of a global contract) | done 2026-11-10 (backlog O10): cost line 7.31032 NEAR read live; Budget `test-new-guard`: Guard `global_contract_hash` `9X9H…dHqyo`, own `code_hash` all ones, 905 bytes of storage, 1.3.0, no keys; agent `a1` has one function-call key (`request_transfer`, `sync_request` on the Guard) |

### Yield (YD0–YD4)

| # | Do | See | Status |
|---|---|---|---|
| Y1 | [yield spike](yield-spike-2026-11-09.md): `check`, `dao`, `fund`, register, supply, withdraw | each proposal Approved. The DAO gets its tokens back, and Rhea Lend shows no supply | done 2026-11-09 on `kdy1794161239.sputnik-v2.testnet` (PR #58) |
| Y2 | `yield_suggestions` (M9) and the dashboard yield page on the Y1 DAO | code-built candidates with their numbers | done 2026-11-09: MCP and the page agree (one candidate, 10.55% APR). The page's Rhea API read was blocked by the CSP, fixed in PR #59 |
| Y3 | dashboard yield page: supply and withdraw signed by the owner | the proposals pass, as in Y1 | done 2026-11-09 on the Y1 DAO: supply #3 and #5 and withdraw-all #4 asked and approved from the page in the owner's wallet |
| Y3b | partial withdraw: Take it back with an amount (PR for the APR preview) | `Withdraw {token_id, amount}` with the amount in Rhea Lend's inner units (raw × 10^12); only that part comes back | done 2026-11-10 on the Y1 DAO: #6 took 1,300,000 of 1,800,020 USDC back (`withdraw_succeeded`, tx `GxZya33VyMeEGQ1e592xBXiY61aXbmqoAREzsrqr2DYE`). Args from the dashboard builder, signed with near-cli. 500,020 stays supplied. The rate went 0.27% → 1.4432%; the drawer's preview said 1.44% |
| Y4 | vote on a yield proposal from the page | only for a kind the page builds | done 2026-11-09: votes on #3–#5 from the page. #6 (partial withdraw) shows its amount and an Approve button |
| Y5 | a Worker model call on the Y1 DAO | reasons from the TEE model. Every number matches the code-built candidate | pass 2026-11-10: `/yield` in Telegram called `Qwen/Qwen3.6-35B-A3B-FP8`, generation `21c7611681a2408f84990e0558759869`. MCP then served the cached advice (`by` model, no fallback). APR 10.56% and `max_amount` `2000020009655` equal the code facts. Found: the reason calls the 10.56% APR an "APY"; `validateAdvice` checks numbers only, not their label |
| Y6 | `NEAR_AI_API_KEY=... scripts/yield-setup/verify-tee.sh` | exit 0, with the result written to `docs/yield-tee-verify.md` | pass 2026-11-10 07:26 UTC (owner): `Qwen/Qwen3.6-35B-A3B-FP8`, hashes, signature, Intel TDX quote and NVIDIA attestation all verified |

### Other

| # | Do | See | Status |
|---|---|---|---|
| X1 | `pnpm stats` (owner, O4) | the README table, with no names | done 2026-11-10 (O4, block 223,787,777) |
| X2 | `examples/near-ai-agent` against the hosted MCP | it calls `preflight` before it pays and stops on `block` | covered by its 8 unit tests; live run optional |
| X3 | re-measure the 140/145 Tgas attach floor | the README gas line matches | pass 2026-11-10 in the sandbox (Guard 1.3.0 wasm, Sputnik v2, `request_transfer` at 140–150 Tgas, a temporary test, not kept): 140–143 fail in the first receipt (3.1 Tgas burnt, no proposal, nothing paid); 144 works for Auto only (15.0 Tgas burnt); 145 is the lowest that works for both Auto and Pending (Pending burns 8.1). README line unchanged. Not re-measured on testnet |

## 5. Order

| Day (UTC) | Claude | Owner |
|---|---|---|
| 11-09 / 11-10 | A1–A4, M1–M10, D1–D7, W1, W6 | **L1 `accounts`** (starts the 48 h clock). B4, B5, B6, B8. K3 |
| 11-11 | record K4 from the chain | K4, K5, K6. Y1. Check W3 at 02:00 UTC |
| 11-12 | Y2, M9 on the Y1 DAO | L1 from `dao` to the end, then L2 and L3 at once. G2 pause, G3, G5 |
| 11-13 | update the README, TEST_MATRIX and backlog from the results | Y3–Y6, B7, W5, M11, X1, X3 |
| 11-14 | A1–A4 one last time on the final commit | submit (not by Claude) |

Cut order if short on time: X3 → X1 → Y5/Y6 → B7/W5 → G5. Never cut A1–A3, M1–M7, L1–L3, K3–K4. A feature that did not pass live goes under Roadmap or Limitations in the README.
