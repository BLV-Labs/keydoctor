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
| [gd1-scan](stories/epics/library/gd1-scan/validation.md) | S1 `scanAccount`, key and account rules, live-run script (S1-AC1 to S1-AC8). Validation before any fetch, one `block_id`, error mapping with no URL or body text. | expected: parse, age, rules, `buildMember`, thresholds source scan | expected: `scanAccount` with a stubbed `fetch`, error and timeout mapping, script `--save-raw` refusal | n/a | expected: `npm run typecheck` (`tsconfig.src.json` has no Node types) | planned | none yet |
| [gd1-scan](stories/epics/library/gd1-scan/validation.md) | S2 function-call rules and receiver checks (S2-AC1 to S2-AC3). One request per distinct receiver, `account-b.report.json` deep-equal. | expected: `FC_UNLIMITED_ALLOWANCE`, `FC_ANY_METHOD`, `FC_DEAD_RECEIVER` | expected: receiver paths with a stubbed `fetch`, `account-b.report.json` deep-equal | n/a | n/a | planned | none yet |
| [gd1-scan](stories/epics/library/gd1-scan/validation.md) | S3 `scanDao` (S3-AC1 to S3-AC6). Council, admin role, DAO rules, member failures, caps, concurrency and vi/en text. | expected: council and vote policy, `DAO_ADMIN`, `FC_DAO_VOTE`, `COUNCIL_SMALL`, messages | expected: `scanDao` with a stubbed `fetch`, `dao-kd-demo.report.json` deep-equal, in-flight count, `fixtures.test.ts` invariant skip | n/a | n/a | planned | none yet |
| [gd1-scan](stories/epics/library/gd1-scan/validation.md) | S4 rule corpus (S4-AC1 to S4-AC3). Each of the 13 rules has one positive and one negative case. The non-`Group` admin role gives its limitation line. | n/a | expected: each corpus file through its scan with a stubbed `fetch`, presence equals `fires` | n/a | n/a | planned | none yet |
| [gd1-scan](stories/epics/library/gd1-scan/validation.md) | `get_policy` with an unknown cause (for example `GARBAGE_COLLECTED_BLOCK`) throws `RPC_ERROR`, not retryable (S3-AC5). | n/a | expected: stubbed `fetch` returns the cause | n/a | n/a | planned | none yet |
| [gd1-scan](stories/epics/library/gd1-scan/validation.md) | A DAO with 21 council members that all have empty key lists sends 44 requests or fewer, and no scan exceeds 45 (S3-AC5). | n/a | expected: stubbed `fetch` counts requests | n/a | n/a | planned | none yet |
| [gd1-scan](stories/epics/library/gd1-scan/validation.md) | GĐ1 done: the owner records items 1 to 7 of the design §11 live-run checklist in `packages/key-doctor/fixtures/README.md` (decision 0001). Each item names the testnet DAO and block height. This is not a test. | n/a | n/a | expected: owner live testnet run with `scripts/scan.ts --save-raw` | n/a | planned | none yet |
