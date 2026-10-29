# Phase 6: Deliver (Orchestrator) — runs automatically after Phase 5

**Goal:** open a PR to `<integration_branch>` for each green, reviewed branch. Then **stop for human review**. The Orchestrator never merges. A human reviews and merges on GitHub. After Phase 5, start this phase without waiting for user approval.

**0. Check the phase log.** Run `python3 .claude/skills/dev-team/scripts/phase_check.py <scratchpad>/<feature>-phases.md` (add `--no-prd` when the profile's `prd` is `none`). On a non-zero exit, stop and run the missing phase.

**1. Check that each branch is exactly the gated state.** This check carries the most weight. The loop proved one specific tree, and promotion must ship *that* tree, nothing more. Between approval and merge, a background follow-up can add commits or leave edits that no gate saw. Examples are a `spawn_task` chip, a stray agent or a concurrent session. Before you push each branch:

- `git -C <worktree> status` is **clean** and `git -C <main-checkout> status` is **clean**. No uncommitted edits ride along. A stray doc in main means someone skipped the worktree. Move it onto the branch first.
- `git -C <worktree> log --oneline origin/<integration_branch>..HEAD` matches the commits the loop gated. No surprise commits sit past the last reviewed SHA. If an output-rewriting proxy (such as rtk) reports a stale or empty HEAD, check with `command git -C <worktree> log -1 --oneline` before you decide anything.
- For a security-gated branch, check that the **scope** the security review approved still matches the code. Examples: the raw-query call sites the audit found to carry the tenant predicate, or the endpoints behind an API-key guard. If the working tree or a new commit grew the scope past the gate, **stop**:
  1. Put the extra work on its own branch (`git branch feature/<x>-followup <sha>`).
  2. `git reset --hard` the feature branch back to the last gated commit.
  3. Send the follow-up through its own Phase 3.6/3.7 gate.

  Never let post-gate work merge under a passed review.

**2. Push and open PRs to `<integration_branch>`.** Open one `feature/* → <integration_branch>` PR per branch. The body is short bullets. It holds:

- the story and a link to the governing PRD Task (when `prd` is set),
- the proof counts and the 3.65 runtime evidence table,
- any required ops follow-up (for example a manual DB migration, a gitops image bump, an env change),
- the Claude Code attribution line at the end.

Then write the delivery summary with `references/html-reports.md`.

**3. Resolve the predictable conflicts.** Several branches can each append rows to `docs.test_matrix` and `docs.backlog`. Sequential merges to `<integration_branch>` then collide on those files. GitHub flips the later PRs to CONFLICTING after the first merge. These are **append conflicts**. Keep **both** row sets: delete the `<<<<<<< / ======= / >>>>>>>` markers and keep every story's rows.

- Merge order: feature branches first, the harness or backlog-only branch last.
- After each merge, check the mergeable state of the next PR. Resolve it in its worktree (`git merge origin/<integration_branch>`, fix the markers, commit, push).

**4. STOP — do NOT merge.** Give the PR links to the human. The human reviews and merges on GitHub with a **normal merge commit, not squash**. The Orchestrator never merges to `<integration_branch>`. **After the human reports the merge:**

1. On the main checkout, run `git checkout <integration_branch> && git pull`.
2. Post the evidence comment on the PRD Task. Close the Task, or write why it stays open.
3. Give the gitops lines to the operator. Never commit them.
4. Run `git worktree remove` on each merged worktree and `git branch -D` on each merged feature branch. Do not reuse them.

Keep any follow-up branch from step 1. Skip cleanup for a PR that the human closed unmerged.

**5. Deploy is its own gated step.** A merge to `deploy_branch` starts the deploy pipeline (for example a gitops image tag). Never merge the PR or advance a downstream deploy step without a separate, explicit go-ahead. Name every ops prerequisite. For example, a pending DB migration must run before the image ships.
