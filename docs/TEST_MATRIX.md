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
| [gd1-scan](stories/epics/library/gd1-scan/validation.md) | S1 `scanAccount`, key and account rules, live-run script (S1-AC1 to S1-AC8). Validation before any fetch, one `block_id`, error mapping with no URL or body text. | `packages/key-doctor/test/scan-rules.test.ts` (rules at thresholds, age boundaries, summary), `test/resolve-target.test.ts`, `test/source-invariants.test.ts` (no `node:*`, `fetch` only in `rpc.ts`, no threshold literal, `RULESET_VERSION`) | `test/scan-errors.test.ts` (HTTP/transport/cause mapping, 15 s timeout with mock timers, stalled body, follow-up, `MAX_KEYS`, no URL/body leak), `test/scan-rules.test.ts` (block pinning), `test/scan-script.test.ts` (`--save-raw`, mainnet refusal with zero requests, via `--import` stub preload) | n/a | `npm run typecheck -w key-doctor` passes | implemented | [2026-10-29] `npm test -w key-doctor`: 129 passed, 0 failed, 0 skipped; line coverage age.ts, errors.ts, rules/account.ts, rules/key.ts 100%. Live RPC not run (HTTP 403 in the QA container); design §11 owner run still open.
| [gd1-scan](stories/epics/library/gd1-scan/validation.md) | S2 function-call rules and receiver checks (S2-AC1 to S2-AC3). One request per distinct receiver, `account-b.report.json` deep-equal. | `test/scan-rules.test.ts` (`FC_UNLIMITED_ALLOWANCE`, `FC_ANY_METHOD` incl. receiver text, `FC_DEAD_RECEIVER`) | `test/scan-receivers.test.ts` (once per distinct receiver, `false`/`null`+`errors[]`/no-request paths, budget cut in code-unit order, FA keys without `receiver_exists`, `account-b.report.json` deep-equal) | n/a | n/a | implemented | [2026-10-29] `npm test -w key-doctor`: 129 passed, 0 failed, 0 skipped
| [gd1-scan](stories/epics/library/gd1-scan/validation.md) | S3 `scanDao` (S3-AC1 to S3-AC6). Council, admin role, DAO rules, member failures, caps, concurrency and vi/en text. | expected: council and vote policy, `DAO_ADMIN`, `FC_DAO_VOTE`, `COUNCIL_SMALL`, messages | expected: `scanDao` with a stubbed `fetch`, `dao-kd-demo.report.json` deep-equal, in-flight count, `fixtures.test.ts` invariant skip | n/a | n/a | planned | none yet |
| [gd1-scan](stories/epics/library/gd1-scan/validation.md) | S4 rule corpus (S4-AC1 to S4-AC3). Each of the 13 rules has one positive and one negative case. The non-`Group` admin role gives its limitation line. | n/a | expected: each corpus file through its scan with a stubbed `fetch`, presence equals `fires` | n/a | n/a | planned | none yet |
| [gd1-scan](stories/epics/library/gd1-scan/validation.md) | `get_policy` with an unknown cause (for example `GARBAGE_COLLECTED_BLOCK`) throws `RPC_ERROR`, not retryable (S3-AC5). | n/a | expected: stubbed `fetch` returns the cause | n/a | n/a | planned | none yet |
| [gd1-scan](stories/epics/library/gd1-scan/validation.md) | A DAO with 21 council members that all have empty key lists sends 44 requests or fewer, and no scan exceeds 45 (S3-AC5). | n/a | expected: stubbed `fetch` counts requests | n/a | n/a | planned | none yet |
| [gd1-scan](stories/epics/library/gd1-scan/validation.md) | GĐ1 done: the owner records items 1 to 7 of the design §11 live-run checklist in `packages/key-doctor/fixtures/README.md` (decision 0001). Each item names the testnet DAO and block height. This is not a test. | n/a | n/a | expected: owner live testnet run with `scripts/scan.ts --save-raw` | n/a | planned | none yet |
