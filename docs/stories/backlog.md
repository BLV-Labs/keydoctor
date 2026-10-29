# Story Backlog — Key Doctor

## Epics

(One short paragraph per epic: link to its stories, governing PRD entry, current status.)

**Library** (`docs/stories/epics/library/`): the pure `packages/key-doctor` library that every surface reuses. Governing entries: `docs/final-idea.md` §13.3 phases GĐ1, GĐ2 and GĐ5, with the §4 contracts and §5 rules. Stories: [gd1-scan](epics/library/gd1-scan/overview.md) (built). GĐ1 is "built" when slices S1 to S4 meet their ACs. It is "done" only after the owner records the live-run checklist in `packages/key-doctor/fixtures/README.md` (decision 0001).

## Selected Stories

| Story | Description | Lane | Status |
|---|---|---|---|
| [gd1-scan](epics/library/gd1-scan/overview.md) | GĐ1 scan library: `rpc.ts`, `scanAccount`, `scanDao`, the 13 rules of §5.1, `messages`, rule corpus, live-run script. "Built" after S1 to S4. "Done" only after the owner records the live-run checklist. | high-risk | built |
| GĐ7/GĐ8 dashboard (no packet yet) | Dashboard input, council, account profile, and the UC8 key cleanup plan (`docs/final-idea.md` §13.3 rows GĐ7 and GĐ8). Owner answers of 2026-10-29: the ML-DSA backup warning shows only once an ML-DSA key exists. The dashboard detects ML-DSA signing from chain data. App keys use "Revoke" and full-access keys use "Delete". These answers still have to go into `docs/design/dashboard/README.md` and the UC8 wording in that flow. | lane unchecked | planned |

## How to Add a Story

1. Create a file in `docs/stories/epics/<epic>/<story>.md` using `docs/templates/story.md`.
2. Add a row to the table above.
3. Add a row to `docs/TEST_MATRIX.md`.
4. For high-risk stories, use the 4-file folder template in `docs/templates/high-risk-story/`.

## Lane Definitions

- **Tiny**: single file, no schema changes, reversible, no test matrix update needed.
- **Normal**: up to 5 files, schema changes possible, needs test matrix updates.
- **High-risk**: cross-cutting, irreversible, security-sensitive, needs 4-file story + design review.
