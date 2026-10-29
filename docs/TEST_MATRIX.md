# Test Matrix — Proof Discipline

The test matrix is the living map of behavior to proof. Every row binds a story to runnable validation evidence.

**Rule**: Do not mark a row "implemented" until tests or validation evidence exist.

## Columns

| Column | Description |
|---|---|
| **Story** | Path to the story packet |
| **Contract** | One-sentence behavioral contract |
| **Unit** | Unit test proof status |
| **Integration** | Integration test proof status |
| **E2E** | End-to-end test proof status |
| **Platform** | Platform/deployment proof status |
| **Status** | `planned` / `in_progress` / `implemented` / `changed` / `retired` |
| **Evidence** | Exact commands run, pass/fail, dates, coverage |

## Status Rules

- **planned**: story exists, no implementation yet.
- **in_progress**: implementation started, proof not yet complete.
- **implemented**: all declared proof levels have passing evidence.
- **changed**: proof exists but code changed since last verification — needs re-run.
- **retired**: no longer relevant (feature removed, superseded).

## Evidence Format

```
[YYYY-MM-DD] <test command>: 12 passed, 0 failed, coverage 94%
```

## Rows

| Story | Contract | Unit | Integration | E2E | Platform | Status | Evidence |
|---|---|---|---|---|---|---|---|
