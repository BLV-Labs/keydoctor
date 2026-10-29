# High-Risk Story: GĐ1 scan library — Execution Plan

## Pre-Implementation

- [x] Design reviewed and approved (Phase 2.7: PO 91, red-team 88, items closed in 9d717f2)
- [x] Story packet complete (overview, design, this plan, validation)
- [x] Decision records written: `docs/decisions/0001-gd1-done-when.md`, `docs/decisions/0002-gd1-rule-set-reading.md`

## Build order

S1, then S2, then S3, then S4 (`docs/design/gd1-scan.md` line 259). One builder per slice. No file is edited in parallel. All `src/` paths are under `packages/key-doctor/src/`. All `fixtures/` paths are under `packages/key-doctor/fixtures/`. Read the builder notes in `design.md` first.

### Step 1: S1 `scanAccount`, key and account rules, live-run script (built)
- **Files**:
  - `src/rpc.ts` (`block`, `viewAccessKeyList`, `viewAccount`)
  - `src/errors.ts`, `src/parse.ts`, `src/age.ts`, `src/messages.ts`
  - `src/rules/thresholds.ts`, `src/rules/key.ts`, `src/rules/account.ts`, `src/rules/index.ts`
  - `src/scan.ts` (`scanAccount`, `buildMember`)
  - `src/index.ts` (exports `scanAccount`, `resolveTarget`, `KdErrorException`, `isKdError`, `RULESET_VERSION`)
  - `packages/key-doctor/scripts/scan.ts`
  - `packages/key-doctor/tsconfig.json` (`include` gains `scripts`)
  - New `fixtures/rpc/block.json` (height 182340111, `timestamp_nanosec` `"1793671210000000000"`), `fixtures/rpc/error.unknown_account.json`, `fixtures/rpc/error.unknown_block.json`, `fixtures/rpc/view_account.empty-target.json`
  - `fixtures/reports/account-b.report.json` (age limitation text at line 153)
- **Changes**: design §2, §3, §5, §6 (account and key rules), §7, §8, §9.
- **ACs**: S1-AC1 to S1-AC8 in `overview.md`.

### Step 2: S2 function-call rules, receivers (built)
- **Files**:
  - `src/rpc.ts` (receiver `viewAccount`)
  - `src/rules/key.ts`, `src/messages.ts`
  - `src/scan.ts` (dedupe, budget, `skipReceiverCheck`)
  - New `fixtures/rpc/view_account.game.json` (receiver of b's app key)
- **Changes**: design §3 (receiver rows), §6 (FC rules), §9 item 5.
- **ACs**: S2-AC1 to S2-AC3.

### Step 3: S3 `scanDao`
- **Files**:
  - `src/rpc.ts` (`callFunction`)
  - `src/rules/dao.ts`, `src/rules/index.ts`, `src/messages.ts`
  - `src/scan.ts` (`scanDao`, pool, caps)
  - `src/index.ts` (exports `scanDao`)
  - `fixtures/rpc/view_access_key_list.a.json`: add the app key (`game.kd-demo.testnet`, any method, unlimited, nonce `165000000000031`). This is the drift fix from `docs/design/dashboard/README.md:141`.
  - New `fixtures/rpc/view_access_key_list.c.json` (the ML-DSA FA key)
  - `fixtures/reports/dao-kd-demo.report.json`: member a gains the FC key, `FC_UNLIMITED_ALLOWANCE`, `FC_ANY_METHOD`, and `FA_OLD` on the keys at heights 120300000 and 101200000 (861 and 1126 days). Totals become `keys_total: 9` and `keys_full_access: 7`. Age text changes at line 420.
- **Changes**: design §3, §4, §6 (DAO rules), §7, §9.
- **ACs**: S3-AC1 to S3-AC6.

### Step 4: S4 rule corpus
- **Files**:
  - `fixtures/corpus/<RULE_ID>.pos.json` and `fixtures/corpus/<RULE_ID>.neg.json` (26 files)
  - `fixtures/corpus/LIMIT_NON_GROUP_ADMIN.json`
  - `fixtures/README.md` (corpus list and the §11 checklist, every item `unconfirmed`)
- **Changes**: each file is `{target, scan: "account" | "dao", network: "testnet", responses, rule, fires}`. The limitation case has `limitation` instead of `rule`. Responses use the raw JSON-RPC shape of `fixtures/rpc/`. Names sit under `kd-corpus.testnet` and `*.kd-corpus.sputnik-dao.testnet`.
- **ACs**: S4-AC1 to S4-AC3.

## Post-Implementation

- [ ] The owner runs the design §11 live-run checklist and records it in `fixtures/README.md`. Until then GĐ1 is "built", not "done".
- [ ] Story status updated in `overview.md` and `docs/stories/backlog.md`.

## Dependencies

- Needs: GĐ0 (workspace, `types.ts`, fixtures) on `main`.
- Blocks: GĐ3 (Worker MCP `diagnose`), GĐ4 (bot `/check`), GĐ10 (dashboard scan). GĐ2 runs in parallel.
