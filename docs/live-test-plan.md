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
| A1 | `pnpm test` | 5 packages, fail 0 | 2026-11-09: 896 tests, fail 0 |
| A2 | `pnpm typecheck` | no errors | run with A1 |
| A3 | `pnpm test:guard` | Guard 130 unit + 24 sandbox, factory 18 unit + 12 sandbox, all pass | 2026-11-09: pass |
| A4 | `pnpm --filter dashboard build` | `dist/` builds with no error | run before each Pages deploy |

## 2. Hosted MCP (Claude, read only, no secret)

Call `https://key-doctor.duonghb53.workers.dev/mcp` with a JSON-RPC body (node `fetch`, not curl through rtk). The limit is 30 calls a minute per IP.

| # | Tool | Do | See |
|---|---|---|---|
| M1 | `initialize`, `tools/list` | list the tools | 7 tools: `diagnose`, `compare`, `list_keys`, `list_proposals`, `watch`, `preflight`, `yield_suggestions` |
| M2 | `diagnose` | `kdoncall.sputnik-v2.testnet`, summary, then full report | `kd.report_summary.v1`, then `kd.report.v1` with ruleset `2026-11-03`. D1 is not written |
| M3 | `diagnose` | an account that does not exist | `isError` with `kd.error.v1` `NOT_FOUND` |
| M4 | `compare` | the same target twice | the first call stores a baseline. The second gives the same `changes`, and the baseline does not move |
| M5 | `list_keys` | `kdoncall-p.testnet` | its keys, each with its age from the nonce |
| M6 | `list_proposals` | `kdoncall.sputnik-v2.testnet` | the latest proposals with their kind and status |
| M7 | `preflight` | `kdoncall-p.testnet` | `allow` or `warn` with reasons. A `block` case is L2 |
| M8 | `watch` | a bad target | refused without writing. A real `watch` writes a subscription, so it belongs to the owner in B6 |
| M9 | `yield_suggestions` | a DAO with no token | an empty list with its reason, ruleset `2026-11-08` |
| M10 | rate limit | 31 calls in one minute | the 31st is refused with `RATE_LIMITED` |
| M11 | Codex as a client | owner adds the MCP URL to Codex and asks for `diagnose` | the same report as M2 (still open) |

## 3. Dashboard, read only (Claude, built-in browser)

`https://key-doctor-dashboard.pages.dev`. At 1280 px and 375 px, check for no horizontal scroll and no console errors.

| # | Page | Do | See |
|---|---|---|---|
| D1 | check | `?target=kdoncall.sputnik-v2.testnet` | members sorted high → cleanup → note → ok, each linking to `?target=<id>&from=<dao>`, and a `/watch` hint |
| D2 | check | `?target=kdoncall-p.testnet` | its keys and the cleanup plan (UC8 order) |
| D3 | mcp | open it | the URL and the 7 tools, matching M1 |
| D4 | guard | `?page=guard&dao=kdg1793607117.sputnik-v2.testnet` | the Guard card or the create form; bad input refused field by field (guard-test-guide T2) |
| D5 | budget | open it with no wallet | the Cautious and Balanced presets and their funding minimum |
| D6 | my-agents, yield | open them with no wallet | "connect a wallet" and nothing written |
| D7 | old links | `?page=oncall`, `?page=agents`, `?page=guard` with no `dao` | check with the alerts drawer open; budget with add-agent; budget |

## 4. Live flows (owner signs, Claude reads the chain and records)

### Telegram bot

| # | Do | See | Status |
|---|---|---|---|
| B1 | `/check kdoncall.sputnik-v2.testnet` in private | the summary in vi and en. D1 is not written | done earlier |
| B2 | `/changes <dao>` twice | the same changes both times. The baseline does not move | done earlier |
| B3 | `/watch <dao>` in the group | a confirmation, and one row per chat and target | done earlier |
| B4 | `/list`, then `/unwatch <dao>`, then `/list` | the DAO is listed, then gone | **open** |
| B5 | a plain message naming `x.testnet` in private | the same as `/check x.testnet`. In a group with no name, no reply | **open** |
| B6 | dashboard check page, **Watch in Telegram** | the link opens the bot. `/start <code>` subscribes once. The same code a second time is refused | **open** |
| B7 | `/yield <dao>`, `/yield_watch <dao>`, `/yield_unwatch <dao>` on a DAO from Y1 | suggestions, then a subscription, then none | **open** |
| B8 | remove the bot from a test group that watches the demo DAO, make a new proposal, then run W2 | the send to that chat fails and its subscriptions are deleted | **open** |

### Worker jobs (`/run-check`, owner holds the token)

`curl -X POST "$KD_WORKER_URL/run-check" -H "authorization: Bearer $RUN_CHECK_TOKEN" -d '{"job":"<job>"}'`

| # | Job | See | Status |
|---|---|---|---|
| W1 | `GET /` with no token | `ok` (text/plain) | Claude can run it |
| W2 | `proposals` twice | the first run sends any new alert. The second sends nothing | done in the demo run of 2026-10-30 |
| W3 | `daily` | a diff for each watched target. Also watch the cron at 02:00 UTC (09:00 in Vietnam) once | **cron firing open** |
| W4 | `keeper` | `errors: []` | runs every 15 min. No step executed yet (K below) |
| W5 | `yield` | a push to chats from B7 | **open** |
| W6 | `run-check` without the token | 401 | Claude can run it |

### Attack demo (main scene, `scripts/demo-testnet/demo.sh`)

| # | Do | See | Status |
|---|---|---|---|
| L1 | `accounts` (48 h early), `dao`, `/watch` in the group, `transfer`, `compromise`, `vote`, `run-check`, `governance`, `run-check` | a high alert naming b and c after the vote, then the governance alert. No other alerts | needs a fresh prefix |
| L2 | within 48 h of `compromise`, `preflight` on member a over MCP | `block`, naming the new full-access key | **open** |
| L3 | after L1, `diagnose` on the demo DAO, and the dashboard check page | a's new key is flagged, and the dashboard shows the red 48 h box | **open** |

### Agent Guard (v1 factory, [guard-test-guide.md](guard-test-guide.md))

| # | Do | See | Status |
|---|---|---|---|
| G1 | T3: invoices inv-001 to inv-004 through `apps/guard-mcp` | three `auto_approved`, inv-004 `pending` with three reasons, not split | done earlier |
| G2 | T4 rows 1–6: limits and the guardian pause | `OVER_PER_TX`, `OVER_DAILY_LIMIT`, `NOT_WHITELISTED`, `TOO_MANY_PENDING`, `PAUSED` | pause **open** |
| G3 | T5: **Propose a change**, **Pause now** with a non-guardian wallet, **Propose retire** | the `set_policy` proposal; the pause refused before the wallet opens; a `ChangePolicy` that removes only the Guard | pause and retire **open** |
| G4 | T6: Telegram alerts for auto, pending and failed | the three alert kinds, then nothing new on the next run | done earlier |
| G5 | sign one Guard action with Here and one with HOT | the same result as Meteor | **open** |

### Agent Budget (v2 factory) and keeper

| # | Do | See | Status |
|---|---|---|---|
| K1 | Budget page, Cautious preset: sign 1, sign 2, download the key file | the four checks after sign 2 pass, and the key file has one function-call key limited to the Guard | done 2026-11-08 (`payroll-1`, `payroll-2`) |
| K2 | leave the page before downloading | the unsaved-key question | unit-tested; see it live on the next Budget creation |
| K3 | a DAO `FunctionCall` proposal on `payroll-1`: `create_plan` on its Guard with `Transfer` to a whitelisted receiver, `amount_per_run` ≤ `max_per_tx`, `interval_sec` ≥ 60, `runs_total` 2, `start_at` in the past; approve it | `plan_created` event, and `get_plans` shows it `Active` | **open** |
| K4 | wait for the keeper (minutes 7, 22, 37, 52) or run W4 | `execute_plan_step` from `keydoctor-keeper.testnet`, the receiver paid, `runs_done` 1, then 2 on the next cycle, and nothing after | **open, the main keeper proof** |
| K5 | guardian `pause` on a Budget | one `budget_owner_action` message in its chats on the next keeper cycle | **open** |
| K6 | My Agents page with the owner wallet | `payroll-1` and `payroll-2` with their plan and limits | **open** |

### Yield (YD0–YD4)

| # | Do | See | Status |
|---|---|---|---|
| Y1 | [yield spike](yield-spike-2026-11-09.md): `check`, `dao`, `fund`, register, supply, withdraw | each proposal Approved. The DAO gets its tokens back, and Rhea Lend shows no supply | **open, fill the results table** |
| Y2 | `yield_suggestions` (M9) and the dashboard yield page on the Y1 DAO | code-built candidates with their numbers | **open** |
| Y3 | dashboard yield page: supply and withdraw signed by the owner | the proposals pass, as in Y1 | **open** |
| Y4 | vote on a yield proposal from the page | only for a kind the page builds | **open** |
| Y5 | a Worker model call on the Y1 DAO | reasons from the TEE model. Every number matches the code-built candidate | **open** |
| Y6 | `NEAR_AI_API_KEY=... scripts/yield-setup/verify-tee.sh` | exit 0, with the result written to `docs/yield-tee-verify.md` | **open** |

### Other

| # | Do | See | Status |
|---|---|---|---|
| X1 | `pnpm stats` (owner, O4) | the README table, with no names | **open** |
| X2 | `examples/near-ai-agent` against the hosted MCP | it calls `preflight` before it pays and stops on `block` | covered by its 8 unit tests; live run optional |
| X3 | re-measure the 140/145 Tgas attach floor | the README gas line matches | **open** |

## 5. Order

| Day (UTC) | Claude | Owner |
|---|---|---|
| 11-09 / 11-10 | A1–A4, M1–M10, D1–D7, W1, W6 | **L1 `accounts`** (starts the 48 h clock). B4, B5, B6, B8. K3 |
| 11-11 | record K4 from the chain | K4, K5, K6. Y1. Check W3 at 02:00 UTC |
| 11-12 | Y2, M9 on the Y1 DAO | L1 from `dao` to the end, then L2 and L3 at once. G2 pause, G3, G5 |
| 11-13 | update the README, TEST_MATRIX and backlog from the results | Y3–Y6, B7, W5, M11, X1, X3 |
| 11-14 | A1–A4 one last time on the final commit | submit (not by Claude) |

Cut order if short on time: X3 → X1 → Y5/Y6 → B7/W5 → G5. Never cut A1–A3, M1–M7, L1–L3, K3–K4. A feature that did not pass live goes under Roadmap or Limitations in the README.
