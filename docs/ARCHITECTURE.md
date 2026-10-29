# Architecture — Key Doctor

Skeleton: no code exists yet. The planned design is `docs/final-idea.md` §1, §7, §8, §12; fill the sections below from the code as phases land.

## Stack

- **TypeScript, npm workspaces** — monorepo (`packages/*`, `apps/*`).
- **`packages/key-doctor`** — pure library using only `fetch` (browser, Node, Workers): `scanDao`, `scanAccount`, `checkProposals`, `diffReports`, `toSummary`.
- **Cloudflare Workers + D1 (free plan)** — `apps/worker`: Telegram webhook, MCP (Streamable HTTP), `/run-check`, crons (15-minute proposal watch, daily key diff `0 2 * * *`).
- **Cloudflare Pages** — `apps/dashboard`: static site, scans run in the browser.
- **NEAR RPC (public)** — read-only data source; every query in one scan is pinned to one `block_height`.
- **Telegram Bot API** — the only alert channel.

## System Overview

(High-level architecture: what services exist, how they communicate, what the data flow looks like.)

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
