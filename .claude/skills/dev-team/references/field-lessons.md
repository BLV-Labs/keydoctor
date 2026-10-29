## Field lessons

### Briefs
- Copy every concrete fact in a brief (symbol, path, number) from code or an agent report, never from memory or an unverified packet.
- Keep builder briefs free of testing and verification instructions and never name the tester; builders build the acceptance criteria and nothing more.
- Lint every brief and reply with the project's text linter before each spawn, not only packets.
- Read an issue's body and edit history before briefing a "correct X in issue N" task; the issue may never have had the wording.
- Check the output a brief permits against the brief's own limits: a "read only" brief forbids writing files, and spec names or test setup go in the hand-back.
- Route a finding or decision added mid-flow to the agent that owns the artifact it changes before any later brief relies on it.
- Pass explicit "execute now, do not stay in plan mode" to every spawned role, and verify the agent type exists before spawning.

### Phases and gates
- Run each phase as written by its own step and record its result before the next starts; a quick self-read never stands in for a phase.
- Apply the repo's Done Definition in the closing phase and re-run every gate; the skill text alone can miss tracker bullets and final steps.
- Resolve reviewer conflicts toward the simpler side; require a real input for every finding; cap tester rounds at two.
- For multi-slice flows, run security, SQL and lead review once across all slices; spec arbitration and runtime checks stay per slice.
- Check every live precondition (account active, gates open, sync window) before a runtime run or live re-run, and do user-approved shared-data writes in the main session.
- If a runtime phase cannot run because branch processes cannot start beside the main stack, record NOT RUN with that reason; it is a documented path, not a gap.

### Git, worktrees and PRs
- Give concurrent writer agents separate worktrees; two writers in one checkout corrupt each other's commits, and worktree isolation never combines with a brief-pinned path.
- Fetch and read the base branch before fixing an auto-filed advisory or dependency issue; one bump often covers several sibling issues.
- Open one PR per task and fold status changes into it or the next PR; a separate docs-only status PR is noise.
- When stacked surface-flip PRs conflict on test-local literals, grep every site that reads the flag before flipping; never resolve with blanket `--ours` or `--theirs`.
- Hand the user cleanup commands that name only files verified against the base, never a whole directory.
- "Shipped" means merged and deployed; check the deployed image tag before blaming or crediting a feature for a production incident.
- A bundled PR can merge past one story's decision gate; compare the gate state with the merge date at the next slice.
- Treat a 503 on a `gh` write as possibly succeeded; list first, never blind-retry.
- Post issue and PR comments from a file (`--body-file`); inline bodies with rule lines break in zsh.
- Keep PR text and issue comments to short bullets: decision, risk, next step.

### Environment and secrets
- Never print values from secret-bearing sources; print names or an allowlist only.
- Output-filtering shell wrappers can mask a lint error, report "formatted correctly" falsely, truncate a body, or report identical files that differ; rerun the raw command before trusting a verdict.
- Silently non-firing scheduled jobs usually mean full disk or a write-stopped store, not a code bug; check infrastructure first.
- When a security-review skill reads git state from the session's main checkout, point the review at the worktree explicitly or review the diff by hand.
- Answer business and strategy questions as business questions; do not convert them into code work or repo changes.
