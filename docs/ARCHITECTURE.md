# Architecture — Key Doctor

Design: `docs/final-idea.md` §1, §7, §8, §11, §12. The code is built; the sections below sum it up, the README Status table says what is deployed and what ran live.

## Stack

- **TypeScript, pnpm workspaces** — monorepo (`packages/*`, `apps/dashboard`, `apps/worker`, `apps/guard-mcp`, `examples/near-ai-agent`; list in `pnpm-workspace.yaml`). `contracts/*` are Rust crates outside the workspace.
- **`packages/key-doctor`** — pure library using only `fetch` (browser, Node, Workers): `scanDao`, `scanAccount`, `checkProposals`, `diffReports`, `toSummary`.
- **Cloudflare Workers + D1 (free plan)** — `apps/worker`: Telegram webhook, MCP (Streamable HTTP), `/run-check`, `POST /api/watch-link`, and four crons (`apps/worker/wrangler.toml`; the `scheduled` handler in `src/index.ts` picks the job by cron string): `*/15 * * * *` proposal watch, `0 2 * * *` daily key diff, `7,22,37,52 * * * *` keeper, `11,26,41,56 * * * *` yield push.
- **Cloudflare Pages** — `apps/dashboard`: static site, scans run in the browser.
- **NEAR RPC (public)** — read-only data source; every query in one scan is pinned to one `block_height`.
- **Telegram Bot API** — the only alert channel.

## System Overview

- **Worker MCP** (`apps/worker/src/mcp/server.ts`): 7 tools, no auth, rate-limited per IP. `diagnose`, `list_keys`, `list_proposals`, `preflight`, `yield_suggestions` are read-only; `compare` and `watch` write D1 (ADR 0003). Telegram commands and MCP tools call the same shared functions.
- **D1** (`apps/worker/migrations`): `0001_init` (`snapshots`, `subscriptions`, `pending_subscriptions`, `proposal_state`, `alerts_sent`), `0002_keeper` (`keeper_state`, `plan_steps`), `0003_yield` (`yield_watches`, `yield_state`), `0004_yield_advice` (`yield_advice`). Only the Worker writes them.
- **Keeper** (`src/jobs/keeper.ts`, `src/keeper/`, ADR 0005): testnet only. It holds one unprivileged key that signs only `execute_plan_step` and `sync_request` on a Budget's Guard, and tells each run in Telegram. It stays off until `KEEPER_ACCOUNT_ID` and the `KEEPER_PRIVATE_KEY` secret are set.
- **Yield agent** (`packages/key-doctor/src/yield/`, `src/jobs/yield.ts`, ADR 0004): `scanVault` reads DAO balances, open transfers and Rhea Lend rates; code builds every suggestion. The one LLM step is a TEE model on NEAR AI Cloud (`advice.ts`) that orders them and writes reasons; `validateAdvice` rejects anything that does not match the code facts, and a rule-order fallback applies. Advice is cached in `yield_advice`; MCP serves the cache only.
- **`apps/guard-mcp`**: stdio MCP on the agent owner's machine, 5 tools (`guard_get_policy`, `guard_request_transfer`, `guard_get_request_status`, `strategies_list`, `plans_status`). It signs only `request_transfer` / `sync_request` with the agent's function-call key (`AGENT_KEY_PATH`).
- **`contracts/guard`** (Rust, Guard 1.4.0): joins a Sputnik DAO as a member. Policy limits (per payment, per recipient, 24 h) decide Auto or Pending; plans (Scheduled payout, `call`, DCA `swap` on Rhea, ADR 0006/0007); DAO-only `upgrade` and `close`.
- **`contracts/guard-factory`** (Rust): Budget factory `keydoctor-guards-v2.testnet`. A DAO calls `create` by proposal to get its own Guard (the dashboard's Budget flow first creates the DAO on the Sputnik factory), and the Guard creates each keyed agent account. The factory serves the Guard code as a NEP-591 global contract by hash, so a Guard stores 32 bytes instead of a code copy. The v1 factory `keydoctor-guards.testnet` still backs `?page=guard`.
- **Dashboard pages** (`apps/dashboard/src/route.ts`, `?page=`): check (default, `?target=`), `mcp` (Agents), `guard`, `budget`, `my-agents`, `yield`. Reads run in the browser; every write is a transaction or DAO proposal the user's wallet signs.
- **`examples/near-ai-agent`**: sample agent that calls the hosted `preflight` before it pays and stops on `block`.

## Boundaries

### Service Boundaries
(Main services/modules and what each owns. Name the rule that stops one from reaching into another.)

### Data Boundaries
(Databases, schemas, ownership, who may read or write what, how isolation or tenancy is enforced, and what bypasses that enforcement — e.g. raw SQL.)

### External Dependencies
(External services the system depends on. For each: what happens when it is down.)

## Key Patterns

(Recurring architectural patterns: how errors are handled, how state is managed, how services communicate.)

## Non-Functional Targets

### Reliability
(Fault recovery strategy, idempotency rules, retry policies.)

### Efficiency
(Resource budgets, caching strategy, pagination rules.)

### Security
(Auth mechanism, authorization model, sandbox levels for untrusted input.)

### Traceability
(Logging strategy, trace propagation, audit requirements.)

## Anti-Patterns

(Things that look correct but are wrong in this codebase. Common mistakes agents make.)

## ADR Index

See [`docs/decisions/`](decisions/README.md) for detailed architecture decision records.
