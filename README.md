# Key Doctor On Call

Key Doctor checks the access keys of a NEAR account, or of every council member of a Sputnik DAO, and scores the risk with fixed rules. It also stays on call: when a member who just voted on a pending DAO proposal has a freshly added full-access key, the council's Telegram group gets a warning **before the final vote**.

Built at NEAR HACKATHON (1–14 Nov 2026). Tracks: `social` (Sputnik DAO and treasury councils) and `security` (access keys, function-call keys). The design documents are in `docs/` (in Vietnamese; `docs/final-idea.md` is the main one).

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

Fixed rules make every conclusion. **No AI is used in the product**, and Key Doctor **never signs transactions or holds keys**. The one exception is the optional Guard MCP (`apps/guard-mcp`), which runs on the agent owner's machine and signs only Guard requests with the agent's limited function-call key.

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

   You see `# fail 0` for `packages/key-doctor`, `apps/dashboard` and `apps/worker`. The tests run on fixtures and never call a live RPC. `pnpm typecheck` checks all three packages. The library source is checked without Node types, because it may only use `fetch`.

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

   `scripts/demo-testnet/demo.sh` (step 5) adds a new full-access key to member a. For the next 48 hours, ask "can I pay from a.kd-demo.testnet?": the agent calls `preflight` and gets `verdict: "block"` with reason `FA_RECENT`. After 48 hours the same account gets `review` or `allow`. With curl (needs a Worker deployed from this commit):

   ```bash
   curl -s https://key-doctor.duonghb53.workers.dev/mcp -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"preflight","arguments":{"target":"a.kd-demo.testnet"}}}'
   ```

   `block` means a full-access key was added in the last 48 hours: do not sign. `review` means other high or cleanup flags, or keys that could not be read. `allow` means notes only. `preflight` takes one account; a DAO target returns `INVALID_TARGET`.

5. **Telegram bot and the testnet demo** (needs a deployed Worker, see [Deploy](#deploy))

   - Send `/check <dao>` to `@KeyDoctorOnCallBot` and see the summary. `/watch <dao>` in a group subscribes it. `/list` and `/unwatch` manage subscriptions.
   - `scripts/demo-testnet/demo.sh` builds a 3-member DAO that needs 2 votes. Member a gets a new full-access key and approves a transfer. Then `scripts/demo-testnet/demo.sh run-check` (`POST /run-check`), and the group gets a warning that names b and c, who have not voted yet. A governance proposal gets its own warning. Running it again sends nothing new.

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

   The first command builds the wasm and runs 65 unit tests and 9 sandbox tests against the real Sputnik v2 contract in a local `near-workspaces` sandbox. The second prints the gas and allowance lines (`GAS ...`) quoted in [Agent Guard](#agent-guard-contract).

## Status

| Phase | What | State |
|---|---|---|
| GĐ0 | pnpm monorepo, data contracts (`packages/key-doctor/src/types.ts`), fixtures | Done |
| GĐ1 | Scan library: `scanAccount`, `scanDao`, `scanTarget`, 14 rules, vi/en messages | Done (checked against live testnet RPC) |
| GĐ2 | `diffReports`, `toSummary` | Done |
| GĐ3 | Worker: MCP `diagnose`, `compare`, `list_keys`, `list_proposals`, `watch`, D1 baselines, no auth for now | Deployed on Cloudflare; `tools/list` returns the five tools and Claude Code connects (2026-10-30) |
| Agent pre-flight | `FA_RECENT` rule, `preflightVerdict` (`kd.preflight.v1`), MCP `preflight` | Built and tested; not yet deployed, so the live Worker does not list `preflight` |
| GĐ4 | Telegram bot: `/check`, `/changes`, `/watch`, `/unwatch`, `/list`, `/help` | Deployed; webhook live. `/list` and `/unwatch` not yet checked on the live bot |
| GĐ5 | `checkProposals` | Built; four Sputnik proposal facts still to confirm live (`packages/key-doctor/fixtures/README.md`) |
| GĐ6 | Proposal watch cron, `alerts_sent`, `/run-check`, demo script | Deployed; live testnet run 2026-10-30: voter-key and governance alerts reached the group, the second `run-check` repeated nothing ([`docs/demo-testnet-run-2026-10-30.md`](docs/demo-testnet-run-2026-10-30.md)) |
| GĐ7 | Dashboard: check, council, proposal list, account, key detail (what a key is approved for, the dApp), alerts dialog | Deployed to Pages |
| GĐ8 | Cleanup plan, per-key Revoke / Delete signed in Meteor Wallet | Built; Revoke and Delete verified on testnet with a real Meteor account (2026-10-30). No bulk delete |
| GĐ9 | Daily key diff (02:00 UTC) | Built; deployed with the Worker, not yet seen firing live |
| GĐ10 | Network stats script | Built; numbers pending a live run |
| GĐ12 | One-tap watch links: `POST /api/watch-link`, MCP `watch`, `/start <code>`, dashboard "Create links" | Deployed with the Worker; MCP `watch` is in `tools/list`, a link has not been opened live yet |
| GĐ11, GĐ13 | History backtest, NearBlocks key dates | Not built (Roadmap) |
| GĐ15–GĐ17 | Agent Guard contract (`contracts/guard`) | Built; 65 unit tests and 9 sandbox tests against the real Sputnik v2 wasm. A spike version paid a transfer on testnet (2026-11-02) |
| GĐ18 | Guard testnet setup script (`scripts/guard-setup/setup.sh`) | Ran end to end on testnet (2026-11-02): full Guard 1.0.0 deployed, role added, funded and locked; `setup.sh verify` passes |
| GĐ19 | Guard MCP (`apps/guard-mcp`) and demo invoices (`demo/invoices/`) | Built; 42 tests with a mocked chain. Checked live on testnet, read-only (`guard_get_policy`, status lookup, the agent key). No live `guard_request_transfer` yet: the invoice demo runs after 2026-11-04 |

## Agents

The Worker serves MCP over Streamable HTTP at `https://key-doctor.duonghb53.workers.dev/mcp`. There is no auth for now, so anyone can call every tool. `diagnose`, `list_keys`, `list_proposals` and `preflight` are read-only. `compare` and `watch` write to D1 (`compare` moves the baseline only with `update_baseline: true`). Each client IP is limited to 30 `tools/call` per minute (`429 RATE_LIMITED`); the counter lives in each Worker isolate's memory, so it is a soft limit. The dashboard shows the same commands on its **Agents** page.

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
  crons               */15 proposal watch, 0 2 * * * daily key diff
```

- **One block per scan.** Every RPC query in a scan is pinned to the same block height.
- **Key age** comes from the access-key nonce: `floor(nonce / 10^6)` is the block where the key was added.
- **Per-member failures** go into `members[].error` with the text "risk is unknown, not low". They never fail the whole scan.
- **Data contracts** (`kd.report.v1`, `kd.diff.v1`, `kd.alert.v1`, `kd.preflight.v1`, `kd.error.v1`, ...) are in `packages/key-doctor/src/types.ts`.
- **Only the Worker writes subscriptions.** Baselines are written only by the daily job, the first subscription to a target, and `compare` with `update_baseline: true` (or when no baseline exists yet).
- **Proposal job:** one `checkProposals` per DAO. Each alert is sent first and recorded in `alerts_sent` after, so a crash causes a duplicate, never a missed alert. A failed send keeps the old state and retries on the next run.

### Rules (ruleset `2026-11-02`)

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

Proposal watch (`checkProposals`): a voter with a full-access key added in the last 48 hours raises a high alert. So does a new `add_member_to_role`, `remove_member_from_role`, `policy*` or `config` proposal (governance), and a new `upgrade_self` or `upgrade_remote` proposal (code upgrade).

On post-quantum keys: no quantum computer breaks these keys today. The reason to start now is that moving keys takes years, and every public key on NEAR is already public.

## Agent Guard (contract)

`contracts/guard` is a NEAR contract that a DAO adds as a member with the `agent-guard` role (`transfer:AddProposal`, `transfer:VoteApprove`). An AI agent calls `request_transfer`. The Guard always creates a Sputnik transfer proposal. It approves the proposal itself only when the receiver is whitelisted and the amount is within the per-tx, per-recipient and rolling 24-hour limits; otherwise the proposal waits for the council. Only the DAO (by proposal) changes the limits, agents and whitelist. A guardian can pause it; only the DAO unpauses.

Measured in the sandbox (`cargo test --test sandbox -- --nocapture`, gas price 100 million yoctoNEAR per gas, so 1 Tgas costs 0.1 mNEAR; this is the testnet and mainnet minimum):

| `request_transfer` | Gas burnt | Allowance used, net |
|---|---|---|
| Auto (Guard approves, NEAR moves in the same tx) | 14.6 Tgas | 1.33 mNEAR |
| Pending (proposal waits for the council) | 7.9 Tgas | 0.74 mNEAR |

- **Attach 200 Tgas.** The Guard reserves gas for the DAO calls and callbacks up front, so a call with 140 Tgas or less fails before it changes anything; 145 Tgas was the lowest that worked.
- **Agent key allowance.** The agent signs with a function-call key limited to the Guard and to `request_transfer` and `sync_request`. NEAR checks the allowance against the attached gas at a pessimistic price, about 1 mNEAR per Tgas, so at 200 Tgas the key needs more than 0.2 NEAR left even though each call uses about 1 mNEAR after the refund. A key with 0.2 NEAR is refused; 0.25 NEAR (the wallet default) works, but only for about 35 Auto requests. 1 NEAR lasts about 600.

Set up on testnet (run end to end on 2026-11-02; it signs with your own testnet keys through near-cli-rs, and needs `cargo-near`, Node 22 and `jq`):

```bash
KD_GUARD_PREFIX=kdg$(date +%s) scripts/guard-setup/setup.sh all
```

The script creates the council and demo accounts with the testnet faucet, a 3-member DAO that needs 2 votes, deploys and initialises the Guard (5 NEAR per request, 10 NEAR per 24 hours, 3 whitelisted receivers), adds the `agent-guard` role and funds the Guard by DAO proposals, gives the agent account a function-call key limited to the Guard (allowance 1 NEAR), and finally deletes the Guard's full-access keys after a `y/N` prompt. The agent's private key goes to a file (`~/.config/key-doctor/<agent>.json`, mode 600, or `KD_GUARD_AGENT_KEY`), never to the terminal. Done steps are skipped on a re-run; `setup.sh verify` checks the result and `setup.sh info` prints the accounts.

### Guard MCP (agent side)

`apps/guard-mcp` is a stdio MCP server that the agent owner runs next to the agent. It reads its config from the environment and signs with the agent's function-call key file (it refuses a full-access key). Add it to Claude Code with the values `setup.sh info` prints:

```bash
claude mcp add guard -e NEAR_NETWORK=testnet -e GUARD_CONTRACT_ID=<prefix>-guard.testnet -e AGENT_ACCOUNT_ID=<prefix>-agent1.testnet -e AGENT_KEY_PATH=$HOME/.config/key-doctor/<prefix>-agent1.testnet.json -- pnpm --silent --filter guard-mcp start
```

`NEAR_RPC_URL` overrides the default RPC (`rpc.<network>.fastnear.com`). Tools, each returning `kd.guard_result.v1`:

| Tool | Does |
|---|---|
| `guard_get_policy` | Read-only: limits, spent and remaining in the current 24-hour window, reset time, whitelisted receivers |
| `guard_request_transfer` | `receiver_id`, `amount_near` (decimal string, converted to yoctoNEAR exactly), optional `memo`. Signs `request_transfer` with a new `request_id` and 200 Tgas. Returns `auto_approved` (paid), `pending` (a DAO proposal for the council, with reasons) or `rejected` (a Guard error code such as `PAUSED` or `TOO_MANY_PENDING`) |
| `guard_get_request_status` | `request_id`; refreshes a non-final request with `sync_request` |

The tool descriptions and messages tell the agent not to send a pending payment again and not to split it into smaller ones: over the limit is the council's call. When the outcome of a transaction is not known (`UNKNOWN_OUTCOME`), the result carries the tx hash and the agent must check the status instead of retrying.

Invoice demo: put the four invoices in `demo/invoices/` (see its README for another prefix) and ask the agent "Pay the invoices in demo/invoices/ with the guard tool." Expected: the first three are paid at once, the fourth (500 NEAR to `attacker.testnet`, with a prompt injection) becomes a pending proposal for the council.

## Limitations

- ML-DSA keys can be added only in Meteor Wallet (its PQ screen). Key Doctor reads any ML-DSA key on chain but does not add one, and Here and HOT are not claimed to support it.
- A DAO that needs one vote executes a proposal at once, so Key Doctor can only warn after the fact (`after_the_fact: true`).
- Alerts arrive up to one cron period late (15 minutes). Sputnik does not store vote times.
- Alerts reach only chats that subscribed with `/watch`. There is no way to message a NEAR account.
- A key added and then removed between two scans is not seen. Key age is an estimate from the nonce and a 1.2 s block time.
- Scans read public NEAR RPC through FastNEAR (`rpc.<network>.fastnear.com`, free tier) and fall back to `rpc.<network>.near.org` on a rate limit or an outage; see [`docs/data-sources-benchmark.md`](docs/data-sources-benchmark.md) for why and the measured numbers. Public RPC rate-limits heavy use. The Cloudflare free plan limits outbound requests per run, so the proposal job handles at most `MAX_DAOS_PER_RUN` DAOs per run (default 5), at most 12 proposals and 8 voter scans per DAO.
- Scan caps: 100 keys per account, 21 council members, 50 roles.
- Four Sputnik v2 facts that `checkProposals` relies on (proposal-id semantics, proposal JSON, status values, kind labels) were taken from the contract source. A live check on a testnet DAO (2026-10-29) confirmed the first two; the other two are only partly confirmed (`packages/key-doctor/fixtures/README.md`).
- Revoke and Delete work one key at a time. The wallet does not say which key it signs with, so the dashboard keeps two full-access keys. There is no bulk delete.
- Cron messages are bilingual by default (`ALERT_LANG`), because subscriptions do not store a language.
- Agent Guard: the 24-hour window restarts at the first request after it ends (`docs/final-idea.md` §11.5.7), so an agent can spend up to twice `max_per_day` without the council across a reset. Each request record is stored at the Guard's cost and never deleted; requests stop with `INSUFFICIENT_GUARD_BALANCE` once the balance no longer covers the bond plus that storage (or `min_reserve`, if higher).

## Roadmap

- Show the exact time each key was added, from the NearBlocks indexer (`/v1/account/{id}/keys` returns `created` / `deleted`), next to the nonce-based estimate. See `docs/data-sources-benchmark.md`.
- Backtest the proposal rules on 12 months of history (`kd.backtest.v1`), using NearBlocks for keys added and later removed.
- Exact key creation dates from NearBlocks, and more rules.
- **Agent Guard on testnet:** Telegram alerts for Guard proposals, and a Guard card on the dashboard.
- Link a Telegram user to a NEAR account by signature to mention voters by name. Discord and email alerts. Near-real-time watching through an indexer.
- Add ML-DSA keys in the dashboard when wallet-selector supports them. Integration with wallets and treasury tools.

## Deploy

`wrangler` is installed in `apps/worker` only, so run it as `pnpm --filter worker exec wrangler ...` from the repo root.

1. `pnpm --filter worker exec wrangler d1 create key-doctor` and put the id into `apps/worker/wrangler.toml`.
2. `pnpm --filter worker db:migrate:remote`.
3. `pnpm --filter worker exec wrangler secret put <NAME>` for `RUN_CHECK_TOKEN`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`.
4. `pnpm --filter worker run deploy` (`run` is needed: bare `deploy` is a built-in pnpm command).
5. Register the bot webhook:

   ```bash
   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -d url=https://<your-worker>.workers.dev/telegram -d secret_token=$TELEGRAM_WEBHOOK_SECRET -d 'allowed_updates=["message"]'
   ```

6. `KD_WORKER_URL=https://<your-worker>.workers.dev pnpm --filter dashboard build` and publish it with `pnpm --filter worker exec wrangler pages deploy ../dashboard/dist --project-name <name>`. `KD_WORKER_URL` turns on the dashboard's one-tap watch links and adds the Worker to the CSP in `_headers`; leave it out for the copy-the-command dialog only. On the Worker, set `DASHBOARD_URL` (for the "View on dashboard" buttons) and `DASHBOARD_ORIGIN` (the Pages origin allowed to call `/api/watch-link`).

After the first setup (steps 1 to 5), every later release is one command: `pnpm deploy:all`. It reads `.env` (git-ignored; needs `KD_WORKER_URL`, optional `KD_PAGES_PROJECT`, default `key-doctor-dashboard`), runs `pnpm test`, builds the dashboard, publishes it to Pages, then deploys the Worker. Pages gets `--branch main`, so it always goes to production (without it, wrangler uses the current git branch and only makes a preview URL). It stops at the first failure. To release one service only: `pnpm deploy:dashboard` (dashboard tests, build, Pages) or `pnpm deploy:worker` (Worker tests, deploy).

## Libraries, AI-written code and prepared data

- **Runtime:** none. The library and the Worker use only web platform APIs (`fetch`, `crypto.subtle`). The Guard MCP uses only Node built-ins: its borsh encoding and ed25519 signing (`node:crypto`) are written in the repo, checked against bytes from `@near-js/transactions` 2.5.1 in its tests.
- **Fonts:** Fira Sans and Fira Code from Google Fonts.
- **Build and dev tools:**
  - TypeScript
  - esbuild (dashboard bundle)
  - wrangler (Worker dev and deploy, with `undici` pinned to 7.30.1 for a security fix)
  - `@types/node`
- **Tests:** Node's built-in `node:test`, and `node:sqlite` as a stand-in for D1.
- **Agent Guard contract (Rust):** `near-sdk` 5.30, built with `cargo-near`; tests use `near-workspaces` 0.24, `tokio`, `serde_json` and `anyhow`.
- **AI-written code:** all code, tests and English docs in this repo were written by Claude Code (Anthropic) from the team's Vietnamese specs (`docs/final-idea.md`, `docs/usecase.md`). The team wrote the specs, approved the design mockup (`docs/design/dashboard/`) and ran the live testnet checks recorded in `packages/key-doctor/fixtures/README.md`.
- **Prepared data:** the fixtures in `packages/key-doctor/fixtures/` are hand-built with testnet names only. Their public keys are random. The dashboard design handoff was made before the build. `contracts/guard/tests/res/sputnik_dao_v2.wasm` is the Sputnik v2 contract downloaded from a testnet DAO (source and sha256 in that folder's README).

## License

MIT, see `LICENSE`.
