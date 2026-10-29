# Coding Rules — Key Doctor

Skeleton: no code exists yet. Fill the remaining `<...>` lines in GĐ0 from the real config. Add a rule only when a reviewer or agent got it wrong once; a rule born from an incident keeps its reason in one clause.

## Naming

- **Files**: <convention, e.g. kebab-case with a role suffix>.
- **Variables / functions**: <convention>.
- **Classes/Types**: PascalCase. Data contracts live only in `packages/key-doctor/src/types.ts` (`docs/final-idea.md` §4).
- **Constants**: rule thresholds only in `packages/key-doctor/src/rules/thresholds.ts`; changing one bumps `ruleset_version`.
- **Booleans**: <prefix convention>.

## Formatting

<Name the formatter and linter config files (e.g. `.prettierrc`, `eslint.config.*`). They own formatting — follow them, don't restate.>

### Imports
- <Cross-package import rule, e.g. via package names, never relative paths across workspaces.>
- <Grouping rule.>

## Error Handling

- Never swallow errors silently.
- Log errors with context (what failed, why, what was the input).
- Return typed errors, not raw exceptions.
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
- Never sign transactions or hold keys. Never commit private keys, seed phrases or tokens. No LLM in the product.
- `POST /telegram`: check `X-Telegram-Bot-Api-Secret-Token`, return 200 at once, work in `ctx.waitUntil`.
- `POST /mcp`, `POST /run-check`: `Authorization: Bearer` checked before any work.
- `POST /api/watch-link`: CORS only for `DASHBOARD_ORIGIN`.
- D1: parameterized `prepare().bind()` only. Only the Worker writes `subscriptions`; baseline writes only in the daily job and the first subscription.
- RPC: validate `*.near` / `*.testnet` targets before fetching.

## Testing

- Test runner: `npm test` (runner chosen in GĐ0). Required: every rule, `diffReports`, `checkProposals` (fixtures in `packages/key-doctor/fixtures/`), Telegram message rendering.
- Tests verify intent, not just behavior.
- A test that can't fail when business logic changes is wrong.
- Test file location: `test/` mirror per package (e.g. `packages/key-doctor/test/`).
- Tests run on fixtures, never live RPC. Fixtures use testnet names only.

## Git

- Commit messages in English. After each phase, say what was done and what is still missing.
- One logical change per commit.
- Branch naming: `feature/<name>`, `fix/<name>`, `chore/<name>`; agent sessions use their assigned `claude/*` branch.
