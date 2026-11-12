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
- D1: parameterized `prepare().bind()` only. Only the Worker writes `subscriptions`; baseline writes only in the daily job, the first subscription, and `compare` only when no baseline exists (ADR 0003).
- RPC: validate targets with `resolveTarget` before fetching.

## Testing

- Test runner: Node's built-in `node:test` + `node:assert/strict` (`pnpm test`). vitest 4.1 did not install under npm 10, and older vitest has a critical advisory. Required: every rule, `diffReports`, `checkProposals` (fixtures in `packages/key-doctor/fixtures/`), Telegram message rendering.
- Tests verify intent, not just behavior.
- A test that can't fail when business logic changes is wrong.
- Test file location: `test/` per package (e.g. `packages/key-doctor/test/`), shared stubs in `test/support/`. Rust tests sit outside `pnpm test` (see Rust).
- Tests run on fixtures or a stubbed `fetch`, never live RPC. Fixtures use testnet names only.

## Rust

Applies to `contracts/` (near-sdk 5.30). The sections above still apply where they are not TypeScript-specific.

- **Layout**: per contract, `src/lib.rs` holds the state and methods, `src/types.rs` the public types, `src/tests.rs` the unit tests, `tests/sandbox.rs` the sandbox tests. Guard also has `policy.rs` (decision logic, no `env::`), `dao.rs` (Sputnik interface) and `events.rs`.
- **Naming**: Rust defaults. Gas constants are `GAS_*`, limits `MAX_*` / `MIN_*`, callbacks `on_*`. Test names state the behavior (`paused_guard_rejects_requests`).
- **Lint and format**: `cargo clippy --all-targets` is clean, keep it so. There is no rustfmt config and the files do not pass `cargo fmt --check`, so do not reformat a file in a logic change.
- **Errors**: panic only with an UPPER_SNAKE_CASE code, through `require!(cond, "CODE")` or `env::panic_str("CODE")`: `panicCode` in `apps/guard-mcp` matches `[A-Z_]+`. `.unwrap()` only on a value just checked.
- **Amounts**: `U128` in JSON, `u128` inside. Amount math uses `saturating_*` or `checked_*`. Release profiles keep `overflow-checks = true`.
- **State**: `near_sdk::store` collections, keyed by a `BorshStorageKey` enum. Configuration lists have a `MAX_*` cap.
- **Cross-contract calls**: declare the interface with `#[ext_contract]` and give each hop a fixed `GAS_*`. Callbacks are `#[private]` and handle a failed promise explicitly (`#[callback_result]` or `env::promise_result_checked`).
- **Events**: NEP-297 through `emit`, standard `kd_guard` or `kd_guard_factory`.
- **Tests**: `pnpm test:guard` builds the wasm and runs `cargo test` in both contracts. CI does not run it, so run it before committing a contract change. Unit tests mock cross-contract calls; sandbox tests run the real wasm with Sputnik from `contracts/guard/tests/res/`. Testnet names only.

## Git

- Commit messages in English. After each phase, say what was done and what is still missing.
- One logical change per commit.
- Branch naming: `feat/<name>`, `fix/<name>`, `docs/<name>`, `chore/<name>`; agent sessions use their assigned `claude/*` branch.
