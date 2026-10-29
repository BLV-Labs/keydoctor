# Specialist gates — Phase 3.7 & 3.8

These are conditional gates in the implementation loop. Each gate **skips entirely** when its trigger is absent. Must-fix findings block the merge. The loop cap in SKILL.md § Gates applies.

## Phase 3.7: Security review (high-risk lanes only)

Run it **only** when the `docs.intake` lane is high-risk because the change touches a surface in the profile's `high_risk`. Typical surfaces:

- an **auth credential store** (session cookies, provider tokens, API keys),
- **tenant isolation**: a tenant-scoping query injector, or any raw query that must add a tenant predicate,
- an **API-key guard** or the read-API authz surface,
- a **server-side fetch** to external endpoints (SSRF-adjacent),
- **secrets, PII or log hygiene** (provider tokens, credential env values).

Otherwise **skip it entirely**.

**Run it against the worktree.** The `security-review` skill reads the diff of its cwd. Invoked from the orchestrator, it reads the main checkout's empty diff. So spawn the `dev-harness:security-reviewer` agent, whose brief opens with `cd <worktree>` and reviews `git diff origin/<integration_branch>...feature/<feature>`.

- **Must-fix** (auth bypass, secret exposure, cross-tenant data leak through a missing tenant predicate, injection, SSRF): `dev-harness:security-coder` writes the fix. Then Phase 3.6 runs again, then this phase runs again.
- **Advisory:** note it for the user. It does not block.

## Phase 3.8: SQL Pro review (schema or migration changes only)

Run it **only** when the diff adds or changes DB schema or a migration:

- a new or changed table or column,
- a new or changed enum value,
- an index add or drop,
- a changed default or constraint,
- any file under the profile's `schema_dirs`.

Otherwise **skip it entirely**. Spawn `dev-harness:sql-pro` on the schema diff. Give it the changed schema file, the generated migration SQL, and the queries that read or write the changed columns. It assesses two axes.

**Performance:**

- Every column that a query now filters, orders or joins on has index support (composite, partial or covering as needed).
- The change adds no N+1, correlated subquery or unbounded query.
- Every raw query carries its tenant predicate (correctness and isolation).
- The migration is safe on the live DB. On Postgres, new indexes use `CREATE INDEX CONCURRENTLY` in a low-traffic window. `SET DEFAULT` and metadata-only changes are instant. Flag a column add with a volatile default, and a `NOT NULL` backfill that rewrites a hot table.
- EXPLAIN the hot read paths where it can.

**Backward compatibility:**

- Existing rows, indexes, queued jobs and deployed clients survive the migrate→deploy window.
- Status, enum and filter changes keep old and new values valid during rollout. No hard cutover unless the story demands it.
- A changed or added schema default must apply to the live table. If the repo uses Prisma, a changed `@default` attribute alone does NOT change the live Postgres default. It needs a generated migration. Make sure the default lands.
- Existing data is not hidden, orphaned or made invalid.
- Composite unique keys keep the tenant column first, so isolation holds.

**Must-fix** findings:

- a missing index on a hot filter or sort,
- a table-locking migration on a large table,
- an incompatible cutover,
- a default that does not apply,
- a raw query without its tenant predicate.

For a must-fix finding, `dev-harness:sql-pro` writes the fix. Then Phase 3.6 runs again, then this phase runs again.

**Advisory** (for example, a partial index that helps only at future volume): note it for the user. It does not block. If it is worth tracking, open a follow-up ticket.
