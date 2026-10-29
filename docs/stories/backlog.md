# Story Backlog — Key Doctor

## Epics

(One short paragraph per epic: link to its stories, governing PRD entry, current status.)

## Selected Stories

| Story | Description | Lane | Status |
|---|---|---|---|

## How to Add a Story

1. Create a file in `docs/stories/epics/<epic>/<story>.md` using `docs/templates/story.md`.
2. Add a row to the table above.
3. Add a row to `docs/TEST_MATRIX.md`.
4. For high-risk stories, use the 4-file folder template in `docs/templates/high-risk-story/`.

## Lane Definitions

- **Tiny**: single file, no schema changes, reversible, no test matrix update needed.
- **Normal**: up to 5 files, schema changes possible, needs test matrix updates.
- **High-risk**: cross-cutting, irreversible, security-sensitive, needs 4-file story + design review.
