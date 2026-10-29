# dev-team profile

npm workspaces monorepo (planned, GĐ0): `packages/key-doctor` (pure TS library, `fetch` only) + `apps/worker` (Cloudflare Worker, D1, Telegram bot, MCP, crons) + `apps/dashboard` (static Cloudflare Pages site). Repo harness (`AGENTS.md`, `docs/HARNESS.md`) outranks the generic skill where they differ; `CLAUDE.md` and `docs/final-idea.md` outrank both.

```yaml
integration_branch: main           # inferred: only long-lived remote branch
deploy_branch: main                # inferred: no CI/deploy workflows yet
worktree_root: ..
package_manager: npm               # inferred: CLAUDE.md "npm/pnpm workspaces", `npm test`; no lockfile yet
commands:
  setup: npm install               # FAILS: no package.json yet (created in GĐ0)
  typecheck: none                  # not set up yet; add `npm run typecheck` in GĐ0
  lint: none                       # not set up yet
  test: npm test                   # FAILS: no package.json yet (created in GĐ0)
areas:
  backend: [packages/key-doctor, apps/worker, scripts]   # inferred: from docs/final-idea.md §12
  frontend: [apps/dashboard]                             # inferred: from docs/final-idea.md §12
docs:
  stories: docs/stories/
  backlog: docs/stories/backlog.md
  test_matrix: docs/TEST_MATRIX.md
  intake: docs/FEATURE_INTAKE.md
  decisions: docs/decisions/
  architecture: docs/ARCHITECTURE.md
  coding_rules: docs/CODING_RULES.md
  harness_backlog: docs/HARNESS_BACKLOG.md
prd: docs/final-idea.md            # inferred: CLAUDE.md names it the top spec (> docs/usecase.md)
high_risk: [apps/worker/src/telegram, apps/worker/src/mcp, apps/worker/src/index.ts, apps/worker/src/store, packages/key-doctor/src/rpc.ts]   # inferred: webhook secret, Bearer auth on /mcp and /run-check, D1 SQL, RPC fetch of user-supplied targets
schema_dirs: [apps/worker/migrations]   # inferred: D1 migrations, docs/final-idea.md §8.7
dev_server: user-runs-own
verify_skill: none
```

## Phase rules

The phase gates, Phase 5 Done Definition and conventions live in the `dev-harness:dev-team` skill. This file holds repo config only. Repo-specific exceptions:

- Build order follows the GĐ0–GĐ14 table in `docs/final-idea.md` §13.3; a story never starts before its phase's dependencies meet "Xong khi".
- Everything written to the repo is English, except user-facing `messages` (vi + en).
- Never push, make the repo public, deploy to mainnet, post to X or submit the hackathon form without human confirmation.
