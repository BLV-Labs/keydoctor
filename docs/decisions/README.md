# Decision Records

Durable explanations of why important choices were made.

## When to Add a Decision Record

Add a new record when:

- A locked technical choice changes (framework, database, auth provider).
- A product rule changes meaningfully.
- A validation requirement is added, removed, or weakened.
- A high-risk feature chooses one design over another.
- The source-of-truth hierarchy changes.

## How to Add

1. Copy `docs/templates/decision.md`.
2. Number sequentially: `0001-name.md`, `0002-name.md`, etc.
3. Fill in Context, Decision, and Consequences.
4. Link from the relevant story packet.

## Index

| # | Title | Date | Status |
|---|---|---|---|
| [0001](0001-gd1-done-when.md) | GĐ1 done-when: fixture corpus plus one owner live run | 2026-10-29 | Accepted |
| [0002](0002-gd1-rule-set-reading.md) | GĐ1 rule set reading | 2026-10-29 | Accepted |
