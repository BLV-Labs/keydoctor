# 0003 — Open `/mcp`, no shared token

- **Date**: 2026-10-30
- **Status**: Accepted 2026-10-30
- **Deciders**: owner, 2026-10-30 ("temporarily drop `MCP_TOKEN`", issue BLV-Labs/keydoctor#35)
- **Story**: BLV-Labs/keydoctor#35, Part 1

## Context

`docs/final-idea.md` §8.1 says `POST /mcp` always needs `Authorization: Bearer <MCP_TOKEN>`. One shared token means a judge or user cannot call the hosted MCP without asking the owner for it, and the dashboard and README could not show a working `claude mcp add` line. Three of the five tools (`diagnose`, `list_keys`, `list_proposals`) only read public chain data.

The issue first proposed a split: those three public, `compare` and `watch` behind the token because they write to D1.

## Decision

| # | Decision |
|---|---|
| 1 | `/mcp` takes no token. `MCP_TOKEN` is deleted from the deployed Worker (2026-10-30). |
| 2 | **All five tools are open for now**, not just the three read-only ones. This is wider than the split in the issue. |
| 3 | Every `tools/call` is rate-limited by `cf-connecting-ip`: `MCP_RATE_LIMIT_PER_MIN` per minute, default 30. Over the limit gives HTTP 429, `retry-after` and a `RATE_LIMITED` `kd.error.v1` body. |
| 4 | The limiter is an in-memory fixed window per Worker isolate (`apps/worker/src/mcp/rate-limit.ts`). |
| 5 | The other entry points are unchanged: `POST /telegram` keeps its secret-token header and `POST /run-check` keeps `RUN_CHECK_TOKEN`. |

## Alternatives Rejected

- **Keep the shared token**: judges cannot try the product without contacting the owner.
- **Public read tools, token for `compare` and `watch`** (the issue's split): the cleaner design, and the way back when abuse shows up. Not done now because the owner wants one simple no-token setup for the demo.
- **Workers Rate Limiting binding or a D1 counter**: a shared store is stronger, but a binding needs setup in `wrangler.toml` that was not checked against the free plan, and a D1 counter costs a write per call. Neither fits the build window.

## Consequences

**Positive**:
- `claude mcp add --transport http key-doctor <worker>/mcp` and a plain `curl` work with no setup. The README and the dashboard's Agents page say so.

**Tradeoffs**:
- The rate limit is soft. Each isolate counts alone, so several isolates, or a caller spreading over several IPs, can pass 30 per minute. The README says "soft limit".
- `compare` writes a baseline (`snapshots`) on the first call for a target. `watch` creates one-time pending subscription rows (30-minute expiry). Anyone can trigger both. This is bounded by the rate limit, and `watch` subscribes nothing until a person opens the Telegram link.
- This breaks the invariant "baseline writes happen only in the daily job and the first subscription" in a small way: the first `compare` of a target also stores a baseline. It never moves an existing baseline unless `update_baseline: true` is passed, and that flag is also open.

**Revisit trigger**: any sign of abuse, or a D1 write rate that is not explained by the demo. First step then: put `compare` and `watch` back behind a token, keep the three read-only tools open, and move the limiter to a shared store.
