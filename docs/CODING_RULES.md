# Coding Rules — Key Doctor

These rules describe the code as it is. Add a rule only when a reviewer or agent got it wrong once; a rule born from an incident keeps its reason in one clause.

## Naming

- **Files**: kebab-case, no role suffix. Tests are `<name>.test.ts`; the testable part of a script is `<name>-lib.ts`.
- **Variables / functions**: camelCase. Contract fields in `types.ts` and MCP tool names and arguments are snake_case, as in `docs/final-idea.md` §4.
- **Classes/Types**: PascalCase. Data contracts live only in `packages/key-doctor/src/types.ts` (`docs/final-idea.md` §4).
- **Constants**: fixed values are UPPER_SNAKE_CASE. Rule thresholds only in `packages/key-doctor/src/rules/thresholds.ts`; changing one bumps `ruleset_version`.
- **Booleans**: predicates start with `is`, `has` or `can` (`isKdError`, `hasBearer`). Contract fields keep their spec name (`pq_ready`, `executed`).

## Formatting

No formatter or linter is configured. CI runs `pnpm typecheck` and `pnpm test`, and `tsconfig.base.json` sets the compiler rules (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`). Match the surrounding code: double quotes, semicolons, 2-space indent.

### Imports
- Across workspaces: import `key-doctor` by package name, from its root export only.
- Inside a package: relative paths with the `.ts` extension. Type-only imports use `import type` or an inline `type`.
- Packages first, then relative paths, in one block with no blank lines.

## Error Handling

- Never swallow errors silently.
- Log errors with context (what failed, why, what was the input).
- Library failures are typed: throw `fail(code)` from `packages/key-doctor/src/errors.ts` and check with `isKdError`.
- At API boundaries: catch → log → return safe error response.
- A per-member failure goes into `members[].error`; it never fails the whole scan.
- `checkProposals`: a `get_last_proposal_id` failure throws; per-proposal failures go into `errors`.
- Worker endpoints return `kd.error.v1` on failure.

## Comments

- Comment *why*, not *what*.
- Default is no comment. A comment earns its place only when the code is surprising and the reader would otherwise get it wrong.
- Cap: 2 lines. Longer reasons belong in the ADR, the PRD entry, or the commit message.
- No commented-out code in committed files.
- TODO comments must include a ticket/issue reference.

## Security

- Validate all external input at the boundary.
- Never log secrets, tokens, or PII.
- Use parameterized queries — never string interpolation for SQL.
- Principle of least privilege for all service accounts.
- Never sign transactions or hold keys. One exception: `apps/guard-mcp` runs on the agent owner's machine and signs only `request_transfer` / `sync_request` with a function-call key from `AGENT_KEY_PATH` (`docs/stories/epics/guard/plan.md` D3). Never commit private keys, seed phrases or tokens. No LLM in the product, except the yield agent (ADR 0004).
- `POST /telegram`: check `X-Telegram-Bot-Api-Secret-Token`, return 200 at once, work in `ctx.waitUntil`.
- `POST /run-check`: `Authorization: Bearer` with `RUN_CHECK_TOKEN`, checked before any work.
- `POST /mcp`: no token (ADR 0003). Every `tools/call` is rate-limited by `cf-connecting-ip`.
- `POST /api/watch-link`: CORS only for `DASHBOARD_ORIGIN`.
- D1: parameterized `prepare().bind()` only. Only the Worker writes `subscriptions`; baseline writes only in the daily job, the first subscription, and `compare` when no baseline exists or `update_baseline: true` is passed (ADR 0003).
- RPC: validate targets with `resolveTarget` before fetching.

## Testing

- Test runner: Node's built-in `node:test` + `node:assert/strict` (`pnpm test`). vitest 4.1 did not install under npm 10, and older vitest has a critical advisory. Required: every rule, `diffReports`, `checkProposals` (fixtures in `packages/key-doctor/fixtures/`), Telegram message rendering.
- Tests verify intent, not just behavior.
- A test that can't fail when business logic changes is wrong.
- Test file location: `test/` per package (e.g. `packages/key-doctor/test/`), shared stubs in `test/support/`. Rust tests sit outside `pnpm test`: `src/tests.rs` per contract and `contracts/guard/tests/sandbox.rs`.
- Tests run on fixtures or a stubbed `fetch`, never live RPC. Fixtures use testnet names only.

## Git

- Commit messages in English. After each phase, say what was done and what is still missing.
- One logical change per commit.
- Branch naming: `feat/<name>`, `fix/<name>`, `docs/<name>`, `chore/<name>`; agent sessions use their assigned `claude/*` branch.
