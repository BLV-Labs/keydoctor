# Key Doctor On Call

Key Doctor checks the access keys of a NEAR account, or of every council member of a Sputnik DAO, and scores the risk with fixed rules. It also stays on call: when a member who just voted on a pending DAO proposal has a freshly added full-access key, the council's Telegram group gets a warning **before the final vote**.

Built at NEAR HACKATHON (first commit 2026-10-29, see [Hackathon disclosure](#hackathon-disclosure)). Tracks: `social` (Sputnik DAO and treasury councils) and `security` (access keys, function-call keys). The design documents are in `docs/` (in Vietnamese; `docs/final-idea.md` is the main one).

## The problem

On NEAR every public key of every account is public. When someone takes over a council member's account, a common move is to **add a full-access key of their own**, then approve a payout or a rule change. Wallets show only your own account. They do not watch DAO proposals, and they do not connect a new key to a vote.

Network-wide numbers come from one reproducible command (`pnpm stats`, see below). They go here once the script has run against live mainnet RPC.

## What it does

| Part | What you get | Where |
|---|---|---|
| Check | Every key of an account or a whole council, with the reason each one matters and a fixed-rule risk score | Dashboard, Telegram `/check`, MCP `diagnose`, `list_keys` |
| On Call | A warning before the final vote when a voter has a new full-access key. Warnings for proposals that change members, policy or contract code. A daily key-change message | Telegram bot (cron every 15 minutes and at 02:00 UTC) |
| Clean up | A step-by-step plan in a safe order, ticked from chain data when you rescan. Revoke or Delete one key at a time | Dashboard (`view=cleanup`), each change signed by you in Meteor, Here or HOT Wallet (your pick) |
| Compare | What changed since the last baseline | Telegram `/changes`, MCP `compare` |
| Yield | Rhea Lend supply rates for a DAO's stablecoins, capped at the free balance (balance minus open transfer proposals), next to the council's key status. Data for the council, not financial advice: the council decides and signs | Telegram `/yield`, opt-in push `/yield_watch` (every 15 minutes), MCP `yield_suggestions` |

Fixed rules make every conclusion. Key Doctor **never signs transactions or holds keys**. The one exception is the optional Guard MCP (`apps/guard-mcp`), which runs on the agent owner's machine and signs only Guard requests with the agent's limited function-call key.

**AI in the product: one optional step, in the yield agent only** ([ADR 0004](docs/decisions/0004-llm-in-yield-agent.md)). When the Worker has a `NEAR_AI_API_KEY`, the Telegram `/yield` reply and the yield push ask one Private TEE model on NEAR AI Cloud (`Qwen/Qwen3.6-35B-A3B-FP8`) to order the suggestions that code already built and to write a short reason for each. The model gets no tools and no raw report. Code checks its answer (known ids only, every number in a reason must match that suggestion's data, no links or account names) and falls back to the rule order on any failure, never to another model. Scans, rules, alerts, `compare`, `preflight` and every other command use no AI. MCP `yield_suggestions` never calls the model; it returns the last cached model order, or the rule order.

## Live demo (testnet)

- Dashboard: <https://key-doctor-dashboard.pages.dev>
- Council report: <https://key-doctor-dashboard.pages.dev/?target=kdoncall.sputnik-v2.testnet>
- Account cleanup plan: <https://key-doctor-dashboard.pages.dev/?target=kdoncall-p.testnet&view=cleanup>

The scan runs in your browser against public testnet RPC. Revoke and Delete need Meteor Wallet (extension), Here Wallet or HOT Wallet, and the account's own key. **Connect Wallet**, Revoke and Delete open a dialog where you pick the wallet. Meteor is the only wallet checked on testnet so far; Here and HOT load and open their widget but have not signed a Delete yet.

## Try it: do X, see Y

Requires Node.js 22.18+ and pnpm 10. `corepack enable` installs the pnpm version pinned in `package.json`.

1. **Install and test**

   ```bash
   pnpm install
   pnpm test
   ```

   You see `fail 0` for `packages/key-doctor`, `apps/dashboard`, `apps/guard-mcp`, `apps/worker` and `examples/near-ai-agent`. The tests run on fixtures and never call a live RPC. `pnpm typecheck` checks all five packages. The library source is checked without Node types, because it may only use `fetch`.

2. **Scan a testnet DAO in the dashboard**

   ```bash
   pnpm --filter dashboard dev
   ```

   Open `http://localhost:8788/?target=kdoncall.sputnik-v2.testnet`. The scan runs in your browser against public NEAR RPC. You see the council report: status, council size and votes needed for a transfer, members sorted by risk, voting rules, the limits of the scan, and the DAO's newest proposals (kind, status, who voted, who still has to vote). The **Testnet / Mainnet** switch on the home page picks the network for a name typed without a `.near` / `.testnet` suffix (and for implicit accounts); a typed suffix always wins. Mainnet shows no example names. Click a member to see its key profile. On an account, **Open cleanup plan** shows the cleanup steps. **Get Telegram alerts** shows the `/watch` command to copy.

3. **Ask the MCP server for the same verdict**

   Hosted Worker, no token needed:

   ```bash
   curl -s https://key-doctor.duonghb53.workers.dev/mcp -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"diagnose","arguments":{"target":"kdoncall.sputnik-v2.testnet"}}}'
   ```

   Or run it locally:

   ```bash
   cp apps/worker/.dev.vars.example apps/worker/.dev.vars
   pnpm --filter worker db:migrate:local
   pnpm --filter worker dev
   ```

   In another shell:

   ```bash
   curl -s http://localhost:8787/mcp -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"diagnose","arguments":{"target":"kdoncall.sputnik-v2.testnet"}}}'
   ```

   You get `kd.report_summary.v1` with the same `summary.status` and member statuses as the dashboard.

4. **Use it from an agent (Claude Code)** (see also [Agents](#agents))

   ```bash
   claude mcp add --transport http key-doctor https://key-doctor.duonghb53.workers.dev/mcp
   ```

   For a local Worker use `http://localhost:8787/mcp` instead.

   Then ask "check the keys of kdoncall.sputnik-v2.testnet". The agent calls `diagnose`. For the dashboard's detail it has two read-only tools: `list_keys` (one row per access key: member, what it is approved for, age, uses, flags; filter by `account_id`, `permission`, `flagged_only`) and `list_proposals` (the DAO's proposals newest first with votes and who still has to vote; page with `limit` and `offset`). `compare` returns `kd.diff.v1` against the stored baseline and moves the baseline only when you ask (`update_baseline: true`). `watch` returns two one-time Telegram links (`kd.watch_link.v1`): opening one subscribes that chat. `preflight` is a pre-flight for an agent's own account before it signs or pays: it returns `kd.preflight.v1` with `verdict` `allow`, `review` or `block`.

   `scripts/demo-testnet/demo.sh` (step 5) adds a new full-access key to member a (`<prefix>-a.testnet`). For the next 48 hours, ask "can I pay from <prefix>-a.testnet?": the agent calls `preflight` and gets `verdict: "block"` with reason `FA_RECENT`. After 48 hours the same account gets `review` or `allow`. With curl, on a demo account that has no new key (it returned `allow` on 2026-11-04; put your member a in `target` to see `block`, as member a of the 2026-11-09 demo run did):

   ```bash
   curl -s https://key-doctor.duonghb53.workers.dev/mcp -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"preflight","arguments":{"target":"kdoncall-a.testnet"}}}'
   ```

   `block` means a full-access key was added in the last 48 hours: do not sign. `review` means other high or cleanup flags, or keys that could not be read. `allow` means notes only. `preflight` takes one account; a DAO target returns `INVALID_TARGET`.

5. **Telegram bot and the testnet demo** (needs a deployed Worker, see [Deploy](#deploy))

   - Send `/check <dao>` to `@KeyDoctorOnCallBot` and see the summary. `/watch <dao>` in a group subscribes it. `/list` and `/unwatch` manage subscriptions.
   - `scripts/demo-testnet/demo.sh` builds a 3-member DAO that needs 2 votes. Member a gets a new full-access key and approves a transfer. Then `scripts/demo-testnet/demo.sh run-check` (`POST /run-check`), and the group gets a warning that names b and c, who have not voted yet. A governance proposal gets its own warning. Running it again sends nothing new. Send `/watch` before the `transfer` step: a DAO is watched only from the moment it is subscribed, so older proposals never alert. To skip the 48-hour wait for new faucet accounts, use older accounts: set `KD_DEMO_A`, `KD_DEMO_B`, `KD_DEMO_C`, and `KD_DEMO_SIGN=sign-with-legacy-keychain` if their keys are in `~/.near-credentials`.

6. **Reproduce the network numbers**

   ```bash
   pnpm stats
   pnpm stats --block <height> --rpc https://archival-rpc.mainnet.near.org
   ```

   The first command pins the latest final block. The second reruns the scan at a fixed block. The script prints a Markdown table and writes `data/network-stats.json` and `data/network-stats.md`, with aggregates only and no account names.

7. **Benchmark the data sources** (NEAR RPC endpoints vs the NearBlocks API)

   ```bash
   pnpm bench --account <your-account>.testnet --dao kdoncall.sputnik-v2.testnet --runs 5
   ```

   The script prints p50/p95 latency per call, the time of a full scan through each RPC, and, with `--burst N`, when each source starts answering 429. Method, published rate limits and why NearBlocks cannot replace RPC: [`docs/data-sources-benchmark.md`](docs/data-sources-benchmark.md).

8. **Test the Agent Guard contract** (needs Rust with the `wasm32-unknown-unknown` target and `cargo-near`)

   ```bash
   pnpm test:guard
   cd contracts/guard && cargo test --test sandbox -- --nocapture
   ```

   The first command builds both wasm files and runs the Guard's and the Guard factory's unit and sandbox tests against the real Sputnik v2 contract in a local `near-workspaces` sandbox. The second prints the gas and allowance lines (`GAS ...`) quoted in [Agent Guard](#agent-guard-contract).

9. **Yield suggestions for a DAO treasury** (see [Yield agent](#yield-agent))

   ```bash
   curl -s https://key-doctor.duonghb53.workers.dev/mcp -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"yield_suggestions","arguments":{"target":"kdoncall.sputnik-v2.testnet"}}}'
   ```

   You get `{ report, council, advice }`. `report` is `kd.yield.v1`: the DAO's holdings of the allowlisted token, the allowlisted Rhea Lend rates (mainnet USDC and USDt, read only, plus `usdc.fakes.testnet`, the only one marked `executable`), every rejected market with its reason (`NOT_ALLOWLISTED`, ...), and `suggestions`. On 2026-11-08 this DAO returned 3 opportunities (11.17%, 10.97% and 10.54% APR), 32 rejected markets and 0 suggestions, because it holds no `usdc.fakes.testnet`. `council` is the council's key status from the same rules as `diagnose`. `advice` is `null` when there is nothing to order.

   In Telegram: `/yield <dao>` shows the same report, `/yield_watch <dao>` opts the chat in to a message when the top suggestion changes, `/yield_unwatch <dao>` stops it.

   To compare the TEE models yourself (needs your own NEAR AI Cloud key, one small call per model and run):

   ```bash
   NEAR_AI_API_KEY=... pnpm yield-models --runs 3
   ```

   It sends the same synthetic testnet candidates the Worker would send to each model on the TEE list, checks each answer with the Worker's own check, and writes [`data/yield-model-compare.md`](data/yield-model-compare.md) (latency, valid answers, the reasons in vi and en).

## Status

| Phase | What | State |
|---|---|---|
| GĐ0 | pnpm monorepo, data contracts (`packages/key-doctor/src/types.ts`), fixtures | Done |
| GĐ1 | Scan library: `scanAccount`, `scanDao`, `scanTarget`, 14 rules, vi/en messages | Done (checked against live testnet RPC) |
| GĐ2 | `diffReports`, `toSummary` | Done |
| GĐ3 | Worker: MCP `diagnose`, `compare`, `list_keys`, `list_proposals`, `watch`, D1 baselines, no auth for now | Deployed on Cloudflare; Claude Code connects (2026-10-30). The hosted `tools/list` returns all seven tools, with `preflight` and `yield_suggestions` (2026-11-09) |
| Agent pre-flight | `FA_RECENT` rule, `preflightVerdict` (`kd.preflight.v1`), MCP `preflight` | Deployed; `tools/list` lists `preflight` and a live call returns `kd.preflight.v1` (2026-11-04). `block` seen live on 2026-11-09 for the demo's member a, minutes after its new full-access key |
| GĐ4 | Telegram bot: `/check`, `/changes`, `/watch`, `/unwatch`, `/list`, `/help` | Deployed; webhook live. `/list` and `/unwatch` not yet checked on the live bot |
| GĐ5 | `checkProposals` | Built; of four Sputnik proposal facts, two confirmed live and two partly (`packages/key-doctor/fixtures/README.md`) |
| GĐ6 | Proposal watch cron, `alerts_sent`, `/run-check`, demo script | Deployed; live testnet run 2026-10-30: voter-key and governance alerts reached the group, the second `run-check` repeated nothing ([`docs/demo-testnet-run-2026-10-30.md`](docs/demo-testnet-run-2026-10-30.md)). Rerun 2026-11-09 with the same two alerts and nothing else ([`docs/live-test-plan.md`](docs/live-test-plan.md) L1) |
| GĐ7 | Dashboard: check, council, proposal list, account, key detail (what a key is approved for, the dApp), alerts dialog | Deployed to Pages |
| GĐ8 | Cleanup plan, per-key Revoke / Delete signed in Meteor Wallet | Built; Revoke and Delete verified on testnet with a real Meteor account (2026-10-30). No bulk delete |
| GĐ9 | Daily key diff (02:00 UTC) | Built; deployed with the Worker, not yet seen firing live |
| GĐ10 | Network stats script | Built; numbers pending a live run |
| GĐ12 | One-tap watch links: `POST /api/watch-link`, MCP `watch`, `/start <code>`, dashboard "Create links" | Deployed with the Worker; MCP `watch` is in `tools/list`, a link has not been opened live yet |
| GĐ11, GĐ13 | History backtest, NearBlocks key dates | Not built (Roadmap) |
| GĐ15–GĐ17 | Agent Guard contract (`contracts/guard`) | Built; `pnpm test:guard` passes 153 unit, 24 sandbox and 3 DCA sandbox tests for the Guard and 20 unit and 14 sandbox tests for the factory, sandbox against the real Sputnik v2 wasm, and for DCA the testnet wrap, Rhea and USDT wasm (2026-11-09). A spike version paid a transfer on testnet (2026-11-02) |
| GĐ18 | Guard testnet setup script (`scripts/guard-setup/setup.sh`) | Ran end to end on testnet (2026-11-02): full Guard 1.0.0 deployed, role added, funded and locked; `setup.sh verify` passes |
| YD1 | Yield library: `scanVault` reads DAO balances, open transfers and Rhea Lend rates (on-chain and the Rhea API on mainnet), allowlist and floor filters, `kd.yield.v1` | Built; fixture tests, and live reads through the deployed Worker (2026-11-08) |
| YD2 | TEE model step: `adviceRequest`, `validateAdvice`, cached advice in D1 (`yield_advice`), rule-order fallback | Deployed 2026-11-08. Model picked by a live compare of three TEE models ([`data/yield-model-compare.md`](data/yield-model-compare.md)). No model call from the Worker seen live yet: no test DAO holds the token, so there is nothing to order |
| YD3 | Bot `/yield`, `/yield_watch`, `/yield_unwatch`, 15-minute yield push, MCP `yield_suggestions` | Deployed 2026-11-08; a live MCP call returns `kd.yield.v1`. The bot commands and the push not yet checked on the live bot |
| YD4 | Dashboard Yield page (`?page=yield&dao=<dao>`) and My Agents (`?page=my-agents`): the testnet allowlist proposal builder (register, supply, withdraw all as DAO `FunctionCall` proposals the council's wallet signs), council votes, and every agent of the DAOs where a connected account sits on the council | Deployed to Pages 2026-11-09; render and builder tests, live read of `payroll-2.sputnik-v2.testnet` in the browser. No proposal signed from the dashboard yet, so the supply and withdraw path (YD0) is still unproven. Off on mainnet |
| GĐ19 | Guard MCP (`apps/guard-mcp`) and demo invoices (`demo/invoices/`) | Built; 42 tests with a mocked chain. All four invoices run live on testnet (2026-11-02): `inv-001`..`003` `auto_approved`, the DAO paid each receiver in the same tx (15.2 Tgas each); `inv-004` (500 NEAR to `attacker.testnet`) became proposal 5, `pending` with `NOT_WHITELISTED`, `OVER_PER_TX`, `OVER_DAILY_LIMIT`, nothing paid (8.4 Tgas) |
| GĐ25–GĐ28 | Agent Budget: Guard factory v2 (`keydoctor-guards-v2.testnet`), dashboard Budget page (`?page=budget`), Telegram alerts for the owner's actions on a Budget | Deployed on testnet. Run live 2026-11-08 with a wallet on two Budgets, see [Agent Budget page](#agent-budget-page-dashboard-testnet) |
| GĐ31 | DCA: a plan sells NEAR for USDT on Rhea (pool 57) on a schedule, Guard 1.3.0, factory `set_guard_code` ([ADR 0007](docs/decisions/0007-dca-swap-step.md)) | Built and tested; one sandbox step on the real testnet contracts sold 0.1 NEAR for 0.897184 USDT (37.6 Tgas). Not live yet: the factory still serves Guard 1.2.0 and no DCA plan has run on testnet |

## Agents

The Worker serves MCP over Streamable HTTP at `https://key-doctor.duonghb53.workers.dev/mcp`. There is no auth for now, so anyone can call every tool. `diagnose`, `list_keys`, `list_proposals`, `preflight` and `yield_suggestions` are read-only. `compare` and `watch` write to D1 (`compare` moves the baseline only with `update_baseline: true`). Each client IP is limited to 30 `tools/call` per minute (`429 RATE_LIMITED`); the counter lives in each Worker isolate's memory, so it is a soft limit. The dashboard shows the same commands on its **Agents** page.

```bash
claude mcp add --transport http key-doctor https://key-doctor.duonghb53.workers.dev/mcp
```

## How it works

```
packages/key-doctor   pure TypeScript library, fetch only (browser, Node, Workers)
  scanAccount / scanDao / scanTarget → kd.report.v1
  diffReports(prev, curr)            → kd.diff.v1
  toSummary(report)                  → kd.report_summary.v1
  checkProposals(dao, state)         → kd.alert.v1[] + new state (reads RPC only)
apps/dashboard        static site (Cloudflare Pages), scans in the browser
apps/guard-mcp        stdio MCP server for an agent, runs on the agent owner's machine
apps/worker           one Cloudflare Worker + D1
  POST /mcp           MCP Streamable HTTP, no auth for now
  POST /telegram      bot webhook, secret-token header, 200 at once + waitUntil
  POST /run-check     runs a cron job now, Bearer RUN_CHECK_TOKEN
  POST /api/watch-link  one-time /start links, CORS only for DASHBOARD_ORIGIN
  crons               */15 proposal watch, 0 2 * * * daily key diff, 11,26,41,56 * * * * yield push,
                      7,22,37,52 * * * * Agent Budget keeper (off unless its secrets are set)
```

- **One block per scan.** Every RPC query in a scan is pinned to the same block height.
- **Key age** comes from the access-key nonce: `floor(nonce / 10^6)` is the block where the key was added.
- **Per-member failures** go into `members[].error` with the text "risk is unknown, not low". They never fail the whole scan.
- **Data contracts** (`kd.report.v1`, `kd.diff.v1`, `kd.alert.v1`, `kd.preflight.v1`, `kd.error.v1`, ...) are in `packages/key-doctor/src/types.ts`.
- **Only the Worker writes subscriptions.** Baselines are written only by the daily job, the first subscription to a target, and `compare` with `update_baseline: true` (or when no baseline exists yet).
- **Proposal job:** one `checkProposals` per DAO. Each alert is sent first and recorded in `alerts_sent` after, so a crash causes a duplicate, never a missed alert. A failed send keeps the old state and retries on the next run.

### Rules (ruleset `2026-11-03`)

| Rule | Severity | Fires when |
|---|---|---|
| `FA_MANY` | high | 5 or more Ed25519 full-access keys |
| `FA_RECENT` | high | Full-access key added in the last 48 hours (by nonce block) |
| `DAO_ADMIN` | high | One council member can pass a policy change alone |
| `FC_DAO_VOTE` | high | An app key on the DAO contract can call `act_proposal` (vote) |
| `FA_MULTIPLE` | cleanup | 2 to 4 Ed25519 full-access keys |
| `PQ_PARTIAL` | cleanup | Has an ML-DSA key but still Ed25519 full-access keys |
| `FA_OLD` | cleanup | Full-access key older than 730 days, or of unknown age |
| `KEY_UNUSED` | cleanup | Key never used |
| `FC_UNLIMITED_ALLOWANCE` | cleanup | App key with unlimited gas allowance |
| `FC_ANY_METHOD` | cleanup | App key may call any method |
| `FC_DEAD_RECEIVER` | cleanup | App key points to an account that does not exist |
| `FA_BOT_LIKE` | cleanup | Full-access key used 1,000 times or more |
| `PQ_NONE` | note | No ML-DSA (post-quantum) key |
| `COUNCIL_SMALL` | note | Council of 2 or fewer |

Proposal watch (`checkProposals`): a voter with a full-access key added in the last 48 hours raises a high alert. So does a new `add_member_to_role`, `remove_member_from_role`, `policy*` or `config` proposal (governance), and a new `upgrade_self`, `upgrade_remote` or function-call `upgrade` proposal (code upgrade). A transfer proposal from the DAO's [Agent Guard](#agent-guard-contract) raises a high alert when the Guard left it to the council (with the agent, the Guard's reasons and the agent's memo) and a note when the Guard paid it within its limits, so the council sees every Guard payment. Key Doctor treats a proposer as a Guard only when it holds a DAO role and its `kd_guard_info` names this DAO.

On post-quantum keys: no quantum computer breaks these keys today. The reason to start now is that moving keys takes years, and every public key on NEAR is already public.

## Agent Guard (contract)

`contracts/guard` is a NEAR contract that a DAO adds as a member with the `agent-guard` role (`transfer:AddProposal`, `transfer:VoteApprove`). An AI agent calls `request_transfer`. The Guard always creates a Sputnik transfer proposal. It approves the proposal itself only when the receiver is whitelisted and the amount is within the per-tx, per-recipient and rolling 24-hour limits; otherwise the proposal waits for the council. Only the DAO (by proposal) changes the limits, agents and whitelist. A guardian can pause it; only the DAO unpauses. To put an agent behind a Guard on your own DAO, see [docs/guard-integration.md](docs/guard-integration.md). The end-to-end flow, from creating a Guard to an agent payment, is drawn in [docs/guard-flow.md](docs/guard-flow.md).

Measured in the sandbox (`cargo test --test sandbox -- --nocapture`, gas price 100 million yoctoNEAR per gas, so 1 Tgas costs 0.1 mNEAR; this is the testnet and mainnet minimum):

| `request_transfer` | Gas burnt | Allowance used, net |
|---|---|---|
| Auto (Guard approves, NEAR moves in the same tx) | 14.9 Tgas | 1.36 mNEAR |
| Pending (proposal waits for the council) | 8.1 Tgas | 0.76 mNEAR |

- **Attach 200 Tgas.** The Guard reserves gas for the DAO calls and callbacks up front, so a call with 140 Tgas or less fails before it changes anything; 145 Tgas was the lowest that worked.
- **Agent key allowance.** The agent signs with a function-call key limited to the Guard and to `request_transfer` and `sync_request`. NEAR checks the allowance against the attached gas at a pessimistic price, about 1 mNEAR per Tgas, so at 200 Tgas the key needs more than 0.2 NEAR left even though each call uses about 1 mNEAR after the refund. A key with 0.2 NEAR is refused; 0.25 NEAR (the wallet default) works, but only for about 35 Auto requests. 1 NEAR lasts about 600.

Set up on testnet (run end to end on 2026-11-02; it signs with your own testnet keys through near-cli-rs, and needs `cargo-near`, Node 22 and `jq`):

```bash
KD_GUARD_PREFIX=kdg$(date +%s) scripts/guard-setup/setup.sh all
```

The script creates the council and demo accounts with the testnet faucet, a 3-member DAO that needs 2 votes, deploys and initialises the Guard (5 NEAR per request, 10 NEAR per 24 hours, 3 whitelisted receivers), adds the `agent-guard` role and funds the Guard by DAO proposals, gives the agent account a function-call key limited to the Guard (allowance 1 NEAR), and finally deletes the Guard's full-access keys after a `y/N` prompt. The agent's private key goes to a file (`~/.config/key-doctor/<agent>.json`, mode 600, or `KD_GUARD_AGENT_KEY`), never to the terminal. Done steps are skipped on a re-run; `setup.sh verify` checks the result and `setup.sh info` prints the accounts. To use council accounts you already have (their keys are not new, so Key Doctor does not flag them), set `KD_GUARD_A`, `KD_GUARD_B`, `KD_GUARD_C`, and `KD_GUARD_SIGN=sign-with-legacy-keychain` if their keys are in `~/.near-credentials`. `KD_GUARD_FUNDER=<account>` creates the missing accounts from that account (10 NEAR each) instead of the faucet, which rate-limits.

### Guard MCP (agent side)

`apps/guard-mcp` is a stdio MCP server that the agent owner runs next to the agent. It reads its config from the environment and signs with the agent's function-call key file (it refuses a full-access key). Add it to Claude Code with the values `setup.sh info` prints:

```bash
claude mcp add guard -e NEAR_NETWORK=testnet -e GUARD_CONTRACT_ID=<prefix>-guard.testnet -e AGENT_ACCOUNT_ID=<prefix>-agent1.testnet -e AGENT_KEY_PATH=$HOME/.config/key-doctor/<prefix>-agent1.testnet.json -- pnpm --silent --filter guard-mcp start
```

`NEAR_RPC_URL` overrides the default RPC (`rpc.<network>.fastnear.com`). Tools (the three `guard_*` ones return `kd.guard_result.v1`):

| Tool | Does |
|---|---|
| `guard_get_policy` | Read-only: limits, spent and remaining in the current 24-hour window, reset time, whitelisted receivers |
| `guard_request_transfer` | `receiver_id`, `amount_near` (decimal string, converted to yoctoNEAR exactly), optional `memo`. Signs `request_transfer` with a new `request_id` and 200 Tgas. Returns `auto_approved` (paid), `pending` (a DAO proposal for the council, with reasons) or `rejected` (a Guard error code such as `PAUSED` or `TOO_MANY_PENDING`) |
| `guard_get_request_status` | `request_id`; refreshes a non-final request with `sync_request` |
| `strategies_list` | Read-only: the strategy catalog with each status; a `setup_url` to the dashboard for Scheduled payouts when the Guard has plans (1.2.0 or later), and for DCA on testnet. The agent cannot create a plan: it sends the link and the owner signs |
| `plans_status` | Read-only: each plan's amount, runs done of total, status (with the pause reason) and next run, with a dashboard link per plan. Says so when the Guard is older than plans |

The tool descriptions and messages tell the agent not to send a pending payment again and not to split it into smaller ones: over the limit is the council's call. When the outcome of a transaction is not known (`UNKNOWN_OUTCOME`), the result carries the tx hash and the agent must check the status instead of retrying.

### Example agent on NEAR AI Cloud (not part of Key Doctor)

`examples/near-ai-agent` is the agent being guarded, not a Key Doctor feature: no Key Doctor check uses an LLM (the one model step is in the [yield agent](#yield-agent)). A model on NEAR AI Cloud (default `Qwen/Qwen3.8-27B`, a private TEE model with tool calls; `NEAR_AI_MODEL` picks another) decides, and `guard-mcp`, started as a child process over stdio, is its only way to pay. The agent key stays on your machine; NEAR AI sees only the conversation, and `guard-mcp` never gets the NEAR AI key. The model sees only the tools `guard-mcp` lists, and a run stops after 8 model turns.

```bash
NEAR_AI_API_KEY=<from cloud.near.ai> NEAR_NETWORK=testnet GUARD_CONTRACT_ID=<budget>.keydoctor-guards-v2.testnet \
AGENT_ACCOUNT_ID=<agent>.<budget>.keydoctor-guards-v2.testnet AGENT_KEY_PATH=$HOME/.config/key-doctor/<agent>.json \
pnpm --silent --filter near-ai-agent start "Pay 0.1 NEAR to bob.testnet for invoice 7"
# → stderr shows each guard_* call and the Guard's kd.guard_result.v1; stdout is the model's answer
```

Status: unit-tested with a scripted model and a stub MCP server (`pnpm --filter near-ai-agent test`); run live once on 2026-11-08 against NEAR AI Cloud (`Qwen/Qwen3.8-27B`) and a testnet Budget: the model read the policy, asked for 0.1 NEAR to a whitelisted receiver, and the Guard auto-approved it (DAO proposal 5 Approved, tx `czwT4i49Pd9KhZgCookaVmwLapsFBC5wXrmLSDtupDd`). It does not verify the TEE attestation of the model.

### Agent Guard page (dashboard, factory on testnet)

The dashboard's **Agent Guard** page (`?page=guard&dao=<dao>`) lets a council member set up a Guard without the CLI, through a Guard factory (`contracts/guard-factory`):

- It reads the DAO policy and the DAO's Guards from the factory, and shows each Guard's limits, 24-hour window and the agent owner's two commands (the function-call key and the `claude mcp add guard` line).
- The create form builds two `add_proposal` calls, signed in one transaction by the member's wallet: P1 calls `factory.create` (deposit = funding + the Guard's code storage as the factory reports it, about 2.5 NEAR on `keydoctor-guards.testnet`, + 0.01 NEAR for the registry record), P2 adds the Guard to role `agent-guard`. The page checks the member may add both kinds before the wallet opens.
- "Propose a change" builds a DAO → Guard FunctionCall proposal (`set_policy`, `add_agent`, `add_whitelist`, `unpause`, ...).
- "Pause now (guardian)" lets a guardian's wallet sign `pause` on the Guard directly, no vote; only a DAO `unpause` proposal restarts it. "Propose retire" builds the ChangePolicy that removes the Guard from role `agent-guard` (a Guard cannot be deleted). Both are render- and unit-tested only; neither has been signed on testnet yet.
- The council votes in its usual DAO UI. Key Doctor signs nothing and stores nothing.

The factory creates `<name>.<factory>` with its own copy of the Guard code, paid by the DAO's deposit, with `dao_id` = the calling DAO and no access key. Covered by unit tests, dashboard render tests and a sandbox test against the real Sputnik v2 wasm (`pnpm test:guard`). The factory is deployed on testnet as `keydoctor-guards.testnet` (2026-11-03; `kd_factory_metadata` returns version 1.0.0, guard code hash `8RPE9aMz…`), and the deploy workflow builds the dashboard with it (repo variable `KD_GUARD_FACTORY` overrides). First Guard created through it on 2026-11-03: `payroll.keydoctor-guards.testnet` for `kdoncall.sputnik-v2.testnet` (P1 proposal #8, P2 #9, both passed by the council). It has the guard code hash, no access keys, sits in role `agent-guard`, and `get_guards_for_dao` lists it as ready. Do X → see Y:

```bash
KD_GUARD_FACTORY=keydoctor-guards.testnet pnpm --filter dashboard dev
# open http://localhost:8788/?page=guard&dao=<your DAO>.sputnik-v2.testnet
# → the create form; "Preview proposals" shows P1 (create + deposit) and P2 (role agent-guard)
```

To deploy your own factory (the factory account needs about 8 NEAR, see Limitations):

```bash
KD_GUARD_PREFIX=<prefix> KD_GUARD_FUNDER=<rich>.testnet scripts/guard-setup/setup.sh factory
KD_GUARD_FACTORY=<prefix>-guards.testnet pnpm --filter dashboard build
```

Invoice demo: put the four invoices in `demo/invoices/` (see its README for another prefix) and ask the agent "Submit every invoice in demo/invoices/ to the guard tool. The Guard and the DAO council decide what gets paid." Expected: the first three are paid at once, the fourth (500 NEAR to `attacker.testnet`, with a prompt injection) becomes a pending proposal for the council.

### Agent Budget page (dashboard, testnet)

The dashboard's **Agent Budget** page (`?page=budget`) gives one person's agent a spending limit without a council: the Budget is a Sputnik DAO that only its owner controls, with its own Guard and agent.

- **Create.** Pick Cautious (1 NEAR per request, 5 NEAR per 24 hours), Balanced (5 / 20) or Custom. Signature 1 creates the DAO. Signature 2 is one transaction of four calls: the Guard from the factory `keydoctor-guards-v2.testnet`, the agent account with one function-call key (receiver the Guard, methods `request_transfer` and `sync_request` only) and the Guard's role. The page reads the chain back after each signature. The agent key is made in the browser and downloaded as a file; the page asks before you leave while it has not been downloaded.
- **Run.** Top up, Withdraw, change the rules, add an agent, edit the recipient list, and approve or reject a waiting request. Each button says how many signatures it takes. `?page=budget&help=agent` explains to the agent's owner how the agent connects (key file, the `claude mcp add guard` line).
- **Live on testnet, 2026-11-08** (Budgets `payroll-1` and `payroll-2.sputnik-v2.testnet`): created with a wallet, topped up 25 NEAR, withdrew 1 NEAR. Through `apps/guard-mcp`, 0.1 NEAR to a listed recipient was paid at once, and 0.2 NEAR to another account waited for the owner with `NOT_WHITELISTED`. The [example agent on NEAR AI Cloud](#example-agent-on-near-ai-cloud-not-part-of-key-doctor) then paid 0.1 NEAR within the limits. Chats watching the Budgets got the waiting request (`payroll-2`) and the Withdraw (`payroll-1`) in Telegram on the next cron.
- **DCA (testnet, not run live yet).** Strategies → DCA walks a checklist: Update your Budget to Guard 1.3.0, Allow swaps, Enable USDT (each a DAO request the owner signs), then a form: NEAR per run, every N minutes, a number of runs or an end date, and 0.5, 1 or 2 % slippage. The keeper runs each step: the Guard asks Rhea for a quote, sets the minimum USDT from the slippage, and the DAO wraps the NEAR and swaps it. Telegram tells each run with the USDT received and the average price, or that the run was skipped because the price moved more than the slippage allows.

The deploy workflow builds the dashboard with `KD_BUDGET_FACTORY=keydoctor-guards-v2.testnet` (repo variable overrides); a local build without it cannot create a Budget.

## Yield agent

V1 alerts and suggests; it never moves funds. The plan is in [`docs/stories/epics/yield/plan.md`](docs/stories/epics/yield/plan.md).

- **What it reads.** `scanVault` (`packages/key-doctor/src/yield/`) reads, at one block, the DAO's balance of each allowlisted stablecoin and its open transfer proposals, then the Rhea Lend (Burrow) markets. Mainnet rates (native USDC and USDt) come from the Rhea Lend contract and are cross-checked with the Rhea API; they are shown for reference only. On testnet only `usdc.fakes.testnet` is allowlisted and marked `executable`.
- **What it suggests.** Code filters markets by allowlist and floors (mainnet only: at least $1M TVL and $250k liquidity, price within 1% of $1, and the two APR sources within 1 point of each other), then builds one suggestion per held token, capped at the free balance. Thresholds are in `packages/key-doctor/src/yield/thresholds.ts` with their own `yield_ruleset_version`.
- **Council first.** Every reply carries the council's key status, so a council with a `high` flag sees that before any rate.
- **Model step (optional).** See [AI in the product](#what-it-does). The answer is cached in D1 for a day, or until a rate moves by 0.5 points or the free amount changes. The Telegram message shows the model id and its NEAR AI generation id, which can be looked up at NEAR AI's `/v1/signature/{id}`. Model calls from `/yield` and `/yield_watch` are capped at 6 per minute per Worker isolate (and the commands at 3 per chat per minute); past that, the rule order shows. `scripts/yield-setup/verify-tee.sh` checks one call against NEAR AI's attestation verifier ([`docs/yield-tee-verify.md`](docs/yield-tee-verify.md)); it has not been run yet.
- **Push.** `/yield_watch` stores the chat in its own table (`yield_watches`), apart from the security `subscriptions`, so key subscribers never get yield messages they did not ask for. The push cron reads one watched DAO per run (oldest first) and sends only when the top suggestion changes or its APR moves by 0.5 points. Send first, record after; a report with any read error never decides a push. `POST /run-check {"job":"yield"}` runs it now.

## Limitations

- ML-DSA keys can be added only in Meteor Wallet (its PQ screen). Key Doctor reads any ML-DSA key on chain but does not add one, and Here and HOT are not claimed to support it.
- A DAO that needs one vote executes a proposal at once, so Key Doctor can only warn after the fact (`after_the_fact: true`).
- Alerts arrive up to one cron period late (15 minutes). Sputnik does not store vote times.
- Alerts reach only chats that subscribed with `/watch`. There is no way to message a NEAR account.
- A key added and then removed between two scans is not seen. Key age is an estimate from the nonce and a 0.6 s block time.
- Scans read public NEAR RPC through FastNEAR (`rpc.<network>.fastnear.com`, free tier) and fall back to `rpc.<network>.near.org` on a rate limit or an outage; see [`docs/data-sources-benchmark.md`](docs/data-sources-benchmark.md) for why and the measured numbers. Public RPC rate-limits heavy use. The Cloudflare free plan limits outbound requests per run, so the proposal job handles at most `MAX_DAOS_PER_RUN` DAOs per run (default 5), at most 12 proposals and 8 voter scans per DAO.
- Scan caps: 100 keys per account, 21 council members, 50 roles.
- Four Sputnik v2 facts that `checkProposals` relies on (proposal-id semantics, proposal JSON, status values, kind labels) were taken from the contract source. A live check on a testnet DAO (2026-10-29) confirmed the first two; the other two are only partly confirmed (`packages/key-doctor/fixtures/README.md`).
- Revoke and Delete work one key at a time. The wallet does not say which key it signs with, so the dashboard keeps two full-access keys. There is no bulk delete.
- Cron messages are bilingual by default (`ALERT_LANG`), because subscriptions do not store a language.
- Guard factory: the factory keeps the Guard code (about 5.3 NEAR of storage with its own code when built from this repo, locked, not burned), so its account needs about 8 NEAR. Each Guard deploys its own copy, so every DAO pays for its code storage in its create deposit (about 3.3 NEAR from this repo, about 2.5 NEAR on the older `keydoctor-guards.testnet`); that NEAR stays locked on the Guard, which has no key and cannot be deleted. When a `create` fails after the DAO check, the factory refunds the DAO from its own balance, which may run before NEAR returns the failed account's funding to it; keep spare NEAR on the factory, or a large refund can fail and stay on the factory. At most 10 Guards per DAO; that limit is unit-tested only.
- Agent Guard page: it creates proposals only; voting happens in the DAO's own UI. It reads a Guard's views at one block and cannot show requests or pending proposals per agent beyond the counts the Guard returns.
- Trezu treasuries are Sputnik DAOs. A one-off read-only scan of a public mainnet treasury parsed correctly. Trezu has no testnet, so this is not part of the demo and is not reproducible here ([`docs/trezu-integration.md`](docs/trezu-integration.md)).
- Yield agent: supply and withdraw through DAO proposals passed on testnet with the YD0 script on 2026-11-09 ([results](docs/yield-spike-2026-11-09.md)), but no proposal built by the dashboard has been signed yet. The builder is off on mainnet. My Agents lists Yield agents only for DAOs this browser opened on the Yield page, since a Yield agent has no contract to list. Mainnet rates are read for reference; nothing is suggested for execution on mainnet.
- Yield agent: the TEE claim rests on NEAR AI's "Private TEE" model list (`owned_by: "nearai"`). Key Doctor does not verify the attestation on each call, and the one-call check (`verify-tee.sh`) has not been run. No model call from the deployed Worker has been seen yet, because no test DAO holds the allowlisted token. The model can be slow or down; then the rule order shows, marked as such.
- Yield agent: rates move, and a past APR says nothing about the next one. Rhea Lend contract and oracle risk are not scored. The push checks each watched DAO in turn, so with N watched DAOs each is checked every N × 15 minutes. A long Rhea API outage blocks pushes.
- Agent Guard: the 24-hour window restarts at the first request after it ends (`docs/final-idea.md` §11.5.7), so an agent can spend up to twice `max_per_day` without the council across a reset. Each request record is stored at the Guard's cost and never deleted; requests stop with `INSUFFICIENT_GUARD_BALANCE` once the balance no longer covers the bond plus that storage (or `min_reserve`, if higher).
- DCA: testnet only, against Rhea pool 57, which is thin, so its price is a test price (about 7 % under spot when checked). A swap that Rhea refuses still counts as a run and against the 24-hour limit; the NEAR comes back to the Budget wrapped (wNEAR), and unwrapping it is a separate request. There is no Withdraw for USDT yet: it stays in the Budget.

## Roadmap

- Show the exact time each key was added, from the NearBlocks indexer (`/v1/account/{id}/keys` returns `created` / `deleted`), next to the nonce-based estimate. See `docs/data-sources-benchmark.md`.
- Backtest the proposal rules on 12 months of history (`kd.backtest.v1`), using NearBlocks for keys added and later removed.
- Exact key creation dates from NearBlocks, and more rules.
- **Agent Guard:** Guard checks in the council report (`/check`).
- **Agent Budget keeper (GĐ29):** a Worker job that calls due plan steps with an unprivileged testnet key and reports each run in Telegram (ADR 0005). The code and its tests are in `apps/worker`. It has been deployed on testnet since 2026-11-06 and cycles every 15 minutes. Two Budgets exist (2026-11-08) but neither has a plan, so it has never executed a step. See [`apps/worker/README.md`](apps/worker/README.md).
- **Hosted Guard agent (after the hackathon):** each DAO adds its own Telegram bot; a separate Worker turns allowed members' chat into Guard `request_transfer` calls through a model on NEAR AI Cloud. Secrets encrypted per DAO, council-signed registration, the Guard limits and the council vote still decide every payment. It would put an LLM and agent keys in a hosted service, which Key Doctor avoids today, so it is a plan only: `docs/stories/epics/guard/hosted-agent-plan.md`.
- **Yield agent:** a tiny mainnet run of the dashboard proposal builder (YD4b), after the testnet path passes. Later (V2), the agent supplies within council-set limits by itself, through a Guard-style contract. Other protocols and chains (Chain Signatures) after a feasibility check.
- Link a Telegram user to a NEAR account by signature to mention voters by name. Discord and email alerts. Near-real-time watching through an indexer.
- Add ML-DSA keys in the dashboard when wallet-selector supports them. Integration with wallets and treasury tools.

## Deploy

`wrangler` is installed in `apps/worker` only, so run it as `pnpm --filter worker exec wrangler ...` from the repo root.

1. `pnpm --filter worker exec wrangler d1 create key-doctor` and put the id into `apps/worker/wrangler.toml`.
2. `pnpm --filter worker db:migrate:remote`.
3. `pnpm --filter worker exec wrangler secret put <NAME>` for `RUN_CHECK_TOKEN`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`. `NEAR_AI_API_KEY` is optional: without it the yield agent shows the rule order.
4. `pnpm --filter worker run deploy` (`run` is needed: bare `deploy` is a built-in pnpm command).
5. Register the bot webhook:

   ```bash
   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -d url=https://<your-worker>.workers.dev/telegram -d secret_token=$TELEGRAM_WEBHOOK_SECRET -d 'allowed_updates=["message"]'
   ```

6. `KD_WORKER_URL=https://<your-worker>.workers.dev pnpm --filter dashboard build` and publish it with `pnpm --filter worker exec wrangler pages deploy ../dashboard/dist --project-name <name>`. `KD_WORKER_URL` turns on the dashboard's one-tap watch links and adds the Worker to the CSP in `_headers`; leave it out for the copy-the-command dialog only. On the Worker, set `DASHBOARD_URL` (for the "View on dashboard" buttons) and `DASHBOARD_ORIGIN` (the Pages origin allowed to call `/api/watch-link`).

After the first setup (steps 1 to 5), every later release is one command: `pnpm deploy:all`. It reads `.env` (git-ignored; needs `KD_WORKER_URL`, optional `KD_PAGES_PROJECT`, default `key-doctor-dashboard`), runs `pnpm test`, builds the dashboard, publishes it to Pages, then deploys the Worker. Pages gets `--branch main`, so it always goes to production (without it, wrangler uses the current git branch and only makes a preview URL). It stops at the first failure. To release one service only: `pnpm deploy:dashboard` (dashboard tests, build, Pages) or `pnpm deploy:worker` (Worker tests, deploy).

## Libraries, AI-written code and prepared data

- **Runtime:** the library and the Worker have no dependencies and use only web platform APIs (`fetch`, `crypto.subtle`). The dashboard uses `@near-wallet-selector/core`, `meteor-wallet`, `here-wallet` and `hot-wallet` 10.1.4, `near-api-js` 6.5.1 and `@near-js/crypto` 2.5.1 for wallet signing. The example NEAR AI agent (`examples/near-ai-agent`) uses only `fetch` and Node built-ins. The Guard MCP uses only Node built-ins: its borsh encoding and ed25519 signing (`node:crypto`) are written in the repo, checked against bytes from `@near-js/transactions` 2.5.1 in its tests.
- **AI at runtime:** the yield agent's optional model step calls NEAR AI Cloud (`cloud-api.near.ai`, OpenAI-compatible chat completions over `fetch`, no SDK) with a Private TEE model, `Qwen/Qwen3.6-35B-A3B-FP8`. Nothing else in the product calls a model.
- **Fonts:** Fira Sans and Fira Code from Google Fonts.
- **Build and dev tools:**
  - TypeScript
  - esbuild (dashboard bundle), with the `buffer` and `util` browser polyfills
  - wrangler (Worker dev and deploy, with `undici` pinned to 7.30.1 for a security fix)
  - `@types/node`
- **Tests:** Node's built-in `node:test`, and `node:sqlite` as a stand-in for D1.
- **Agent Guard contract (Rust):** `near-sdk` 5.30, built with `cargo-near`; tests use `near-workspaces` 0.24, `tokio`, `serde_json` and `anyhow`.
- **AI-written code:** all code, tests and English docs in this repo were written by Claude Code (Anthropic) from the team's Vietnamese specs (`docs/final-idea.md`, `docs/usecase.md`). The team wrote the specs, approved the design mockup (`docs/design/dashboard/`) and ran the live testnet checks recorded in `packages/key-doctor/fixtures/README.md`.
- **Dev workflow files:** `.claude/` (agents, skills) and the harness docs in `docs/` steer Claude Code during the build. They are not part of the product.
- **Prepared data:** the fixtures in `packages/key-doctor/fixtures/` are hand-built with testnet names only. Their public keys are random. The dashboard design handoff was made before the build. `contracts/guard/tests/res/sputnik_dao_v2.wasm` is the Sputnik v2 contract downloaded from a testnet DAO (source and sha256 in that folder's README).

## Hackathon disclosure

| Rule | This project |
|---|---|
| Build window (Q-001, Q-003, Q-004) | New project. The first commit is from 2026-10-29, after the 2026-10-19 announcement, so the whole history counts and there is no earlier baseline to separate |
| Other chains (Q-002) | None. NEAR only |
| Networks (Q-007, Q-010) | The demo, contracts and examples run on testnet. Scans can also read mainnet. The yield agent reads mainnet Rhea Lend rates for reference only. NEAR Intents is not used |
| Libraries and AI-written code (Q-005) | See the section above |
| License (Q-014) | MIT, in `LICENSE` |

Track hints used (Q-011 says they are optional):

| Track | Hint | Where |
|---|---|---|
| `social` | Sputnik DAO | `scanDao`, `checkProposals`, the council report and the Telegram alerts read the DAO's policy, proposals and votes. Agent Guard is a DAO member and pays through DAO proposals |
| `security` | Function-call keys | The `FC_*` rules. The Guard agent's key may call only `request_transfer` and `sync_request` |
| `security` | Agent security | MCP `preflight`. Agent Guard's whitelist, per-tx, per-recipient and 24-hour limits |

NEAR AI Cloud: the yield agent's optional model step uses a Private TEE model; Key Doctor does not verify the attestation per call (see Limitations). Trezu is not a feature (see Limitations).

Where NEAR fits: every account's access keys and their permissions are public on chain, and a key's nonce gives the block it was added. Sputnik DAO keeps policy, proposals and votes on chain too. So Key Doctor can connect a new key to a vote with no indexer and no access to anyone's wallet.

## License

MIT, see `LICENSE`.
