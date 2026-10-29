# Harness Components — 11-Responsibility Taxonomy

Every harness, regardless of stack, must address these 11 responsibilities. Mark each as covered, partial, or missing.

## Taxonomy

| # | Responsibility | Description | Status |
|---|---|---|---|
| 1 | **Task specification** | How work is defined before it starts (story packets, specs) | missing |
| 2 | **Context selection** | How agents know what to read and what to skip | missing |
| 3 | **Tool access** | What tools agents can use and under what constraints | missing |
| 4 | **Project memory** | How knowledge persists across sessions (agent memory, docs) | missing |
| 5 | **Task state** | How progress is tracked (story status, TEST_MATRIX) | missing |
| 6 | **Observability** | How agent work is recorded and reviewed (traces, logs) | missing |
| 7 | **Failure attribution** | How failures are traced to their cause | missing |
| 8 | **Verification** | How output is validated (tests, proof, review) | missing |
| 9 | **Permissions** | What agents can and cannot do (auth, sandbox) | missing |
| 10 | **Entropy auditing** | How drift from intended behavior is detected | missing |
| 11 | **Intervention recording** | How human overrides are logged and learned from | missing |

## Coverage Legend

- **covered**: documented, enforced, working
- **partial**: documented but not fully enforced, or working but not documented
- **missing**: no mechanism exists

## Improvement Plan

_(Update this table as the harness matures. Target: all "partial" → "covered", all "missing" → "partial" → "covered" over time.)_
