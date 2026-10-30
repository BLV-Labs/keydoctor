# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Key Doctor ("Key Doctor On Call") is a NEAR HACKATHON entry (build window 1–14 Nov 2026, deadline 23:59 UTC 14/11). All code is written by Claude Code from the Vietnamese spec documents. **Current state, owner tasks and the next Claude tasks live in `docs/stories/backlog.md` (section "Build Order"): read it first when you resume.** GĐ0–GĐ10 and GĐ12 are built; most need a deploy or a live testnet run to count as done.

Spec documents and precedence when they conflict: **`docs/final-idea.md` > `docs/usecase.md` > `proposal-key-doctor.md`** (v2, not in the repo). `docs/near-hackathon.md` holds the contest rules and the submission checklist. Read `docs/final-idea.md` first. §17 is the Claude Code instruction list, §13.3 is the build-phase table.

## Language

Everything written into the repo is in **English**: README, docs, code, comments, identifiers and commit messages, because the judges read the repo in English. The one exception is the user-facing `messages`, which the spec requires to carry both `vi` and `en`. The existing Vietnamese spec files stay as they are.

## Build order

Work through phases GĐ0–GĐ14 in `docs/final-idea.md` §13.3. Do not start a phase until the phases it depends on meet their "Xong khi" (done when) criteria. Start at GĐ0: the monorepo, `types.ts`, fixtures, and a `pnpm test` that passes.
- Critical path: GĐ0 → 1 → 3 → 4 → 5 → 6. GĐ6 (proposal-watch job plus the testnet demo) is the main demo scene.
- Phases allowed to run in parallel: GĐ2 with GĐ1; GĐ7/8 with GĐ5/6; GĐ10 any time after GĐ1.
- Cut order if late: GĐ11 → GĐ13 → GĐ12 → GĐ9. Never cut GĐ0–8, GĐ10, GĐ14.
- After each phase, mark it done in the §13.3 / §13.5 tables and write in the commit message what was done and what is still missing.

## Planned architecture (`docs/final-idea.md` §1, §7, §8, §12)

pnpm workspaces monorepo (`pnpm-workspace.yaml`, version pinned in `packageManager`):
- **`packages/key-doctor`**: pure library. It uses only `fetch` so it runs in the browser, Node and Workers. Exports `scanDao`, `scanAccount`, `checkProposals`, `diffReports`, `toSummary`. Rules live in `src/rules/`, thresholds in `src/rules/thresholds.ts` (changing a threshold means bumping `ruleset_version`). User-facing explanations (vi + en) live in `messages`, and the bot and dashboard reuse them verbatim. Per-member failures go into `members[].error` and never fail the whole scan. Pin every RPC query in a scan to one `block_height`. Key age comes from the nonce: `floor(nonce / 10^6)` is the block where the key was added.
- **`apps/worker`**: one Cloudflare Worker (free plan) with D1. Its entry points are `POST /telegram` (webhook, checks the secret-token header, returns 200 at once and does the work in `ctx.waitUntil`), `POST /mcp` (Streamable HTTP, `Authorization: Bearer`), `POST /run-check`, `POST /api/watch-link` (P1), `GET /` health check, and `scheduled` crons (proposal watch every 15 minutes, daily key diff at `0 2 * * *` UTC). The bot commands and the MCP tools (`diagnose`, `compare`, `watch` (P1)) call the same shared functions. D1 schema: §8.7.
- **`apps/dashboard`**: static Cloudflare Pages site. Scans run in the browser through the library. It never writes subscriptions. Key cleanup is signed by the user in Meteor, Here or HOT Wallet (wallet-selector).

The data contracts in `docs/final-idea.md` §4 (`kd.report.v1`, `kd.report_summary.v1`, `kd.diff.v1`, `kd.alert.v1`, `ProposalWatchState`, `kd.watch_link.v1`, `kd.error.v1`) are canonical. They become code in `packages/key-doctor/src/types.ts`. Do not change them silently: bump `schema_version` and say so in the commit. Conventions: severities are `high` / `cleanup` / `note`, yoctoNEAR amounts are strings, times are ISO 8601 UTC.

## Invariants (easy to break)

- Never sign transactions or hold keys. Never commit private keys, seed phrases or tokens. **No LLM in the product.** Code makes every conclusion, including non-command bot messages, which use a regex for `*.near` / `*.testnet` names.
- **Baseline (`snapshots`) writes** happen in only two places: the daily job (UC7) and the first subscription to a target that has no baseline yet. `/check` and `diagnose` never touch D1. `/changes` and `compare` do not move the baseline unless `update_baseline: true` is passed explicitly.
- **Only the Worker writes `subscriptions`**: bot, MCP `watch` and dashboard all funnel through it.
- `checkProposals` only reads RPC. It never stores or sends anything. `prev = null` records the current last proposal and returns no alerts. A failure on `get_last_proposal_id` throws, while per-proposal errors go into `errors`.
- Proposal job: scan once per DAO (not once per subscription). **Send the alert first, write `alerts_sent` after**, so a crash causes a duplicate, not a missed alert. Delete subscriptions for chats that blocked or removed the bot. On a throw, do not save state.
- `diffReports` is pure. Skip members with `error`, and skip flag changes when `ruleset_version` differs (see the rules in §4.3).
- Use only testnet accounts and DAOs in examples, fixtures and the demo. Never use real mainnet DAO or account names. No account leaderboards.
- Do not do any of these without human confirmation: push or make the repo public, deploy to mainnet, post to X, submit the hackathon form.

## Testing

`pnpm test` (set up in GĐ0) must pass before every commit. Required test coverage: every rule, `diffReports`, `checkProposals` (with `get_proposal` fixtures in `packages/key-doctor/fixtures/`), and Telegram message rendering.

## Submission constraints

AI judges (Claude Code and Codex) check that "the repo runs and matches the README". Every feature the README describes must actually work. Unfinished features go under Roadmap. The README must have "do X → see Y" steps (`pnpm test`, scanning a testnet DAO, a `curl` call to `diagnose`, `scripts/demo-testnet` followed by `/run-check`), a Limitations section, and a list of libraries and AI-written code. Add an MIT `LICENSE`. Full checklist: `docs/near-hackathon.md` §9.3 and `docs/final-idea.md` §14.

## Dev workflow

Workflow: `/dev-team` (repo copy in `.claude/skills/dev-team`, agents in `.claude/agents/`; the `dev-harness` plugin is also enabled) — project profile: `.claude/dev-team.md`.
