# Fixtures

Sample data for tests and for building the dashboard before the scanner exists. Testnet names only; every public key is random bytes, not a real key.

| Folder | Contents | Status |
|---|---|---|
| `reports/` | `kd.report.v1` for DAO `kd-demo.sputnik-dao.testnet` (one member each at `high`, `cleanup`, `ok`) and for account `b.kd-demo.testnet` | Hand-built to the §4.1 contract |
| `alerts/` | `kd.alert.v1` `voter_new_full_access_key` for proposal 2 | Hand-built to the §4.4 contract |
| `rpc/` | Raw `view_access_key_list` JSON-RPC responses | Shape from the NEAR RPC docs |
| `corpus/` | One positive and one negative scan case per rule (26 files) plus `LIMIT_NON_GROUP_ADMIN.json`; see below | Hand-built; run by `test/corpus.test.ts` |
| `sputnik/` | Decoded results of Sputnik v2 `get_policy`, `get_last_proposal_id` (the proposal count, so ids run 0 to 3), `get_proposal` | `get_policy` was checked live in GĐ1. The proposal shapes are not yet checked: see the GĐ5 live-run list below |

Known placeholders, to replace in GĐ1/GĐ5 with data captured from testnet:

- Sputnik `kind` labels, `vote_counts` and `submission_time` formats must be compared with the contract source.
- `created.at` and `age_days` assume a 1.2 s block time; the real scanner reads block timestamps.

## Rule corpus (`corpus/`)

Each file is `{target, scan, network, rule, fires, note, responses}` (the limitation case has `limitation` instead of `rule`). `responses` maps a request to the raw JSON-RPC body the stubbed `fetch` returns: `block`, or `query/<request_type>/<account_id>` for `view_access_key_list`, `view_account` and `call_function` (`get_policy`). A request with no entry fails the test. Accounts sit under `kd-corpus.testnet`, DAOs under `kd-corpus.sputnik-dao.testnet`. The head block is 182340111.

| Rule | Positive | Negative (just under the threshold) |
|---|---|---|
| `FA_MANY` | 5 Ed25519 FA keys | 4 |
| `FA_MULTIPLE` | 2 Ed25519 FA keys | 1 |
| `PQ_PARTIAL` | ML-DSA key plus an Ed25519 FA key | ML-DSA key only |
| `PQ_NONE` | one Ed25519 key, no ML-DSA | ML-DSA key |
| `FA_OLD` | key age 731 days | 730 days (1 block under) |
| `KEY_UNUSED` | `use_count` 0 | 1 |
| `FA_BOT_LIKE` | 1000 uses | 999 |
| `FC_UNLIMITED_ALLOWANCE` | allowance `null` | allowance set |
| `FC_ANY_METHOD` | empty method list | one method |
| `FC_DEAD_RECEIVER` | receiver answers `UNKNOWN_ACCOUNT` | receiver exists |
| `DAO_ADMIN` | policy changes pass with 1 vote | 2 votes |
| `FC_DAO_VOTE` | DAO key may call `act_proposal` | DAO key limited to `add_proposal` |
| `COUNCIL_SMALL` | council of 2 | council of 3 |

`LIMIT_NON_GROUP_ADMIN.json`: an `Everyone` role matching `policy:VoteApprove` gives the "policy changes" limitation line and no `DAO_ADMIN`.

## Live-run checklist (design `docs/design/gd1-scan.md` section 11)

Owner runs `packages/key-doctor/scripts/scan.ts --save-raw`. Only that run changes a status to `confirmed` or `differs: <value>`, and it records the account or DAO name and the block height. All seven items were recorded on 2026-10-29, so GĐ1 is done. Items 1 and 3 differ from the recalled values. Item 1 needed no code change; item 3 was fixed in `parse.ts`.

| # | Recalled value | Status | Account or DAO | Block height |
|---|---|---|---|---|
| 1 | Cause names `UNKNOWN_ACCOUNT`, `UNKNOWN_BLOCK`, `NO_CONTRACT_CODE`, `CONTRACT_EXECUTION_ERROR` | differs (2026-10-29): `UNKNOWN_ACCOUNT` and `UNKNOWN_BLOCK` come back as `error.cause.name`, as expected. The two contract cases come back as a `result.error` string, not as a cause: `wasm execution failed with error: CompilationError(CodeDoesNotExist { … })` for an account with no contract, and `… MethodResolveError(MethodNotFound)` for a non-DAO contract. `rpc.ts` already maps any `result.error` string on `get_policy` to `NOT_A_DAO` (test `scan-dao.test.ts` "result.error string"), so no code change. The cause-name branches stay for RPC nodes that do send them | `kd-does-not-exist-9z.testnet` (missing), the owner's testnet wallet account (no contract), `wrap.testnet` (non-DAO contract) | final (not recorded) |
| 2 | An empty key list (not `UNKNOWN_ACCOUNT`) for a missing account | confirmed (2026-10-29): `view_access_key_list` answered with no `error` and no `result.error`. This is why `scanAccount` follows an empty list with `view_account` | `kd-does-not-exist-9z.testnet` (missing) | final (not recorded) |
| 3 | `mldsa65:` key prefix | differs: `ml-dsa-65-hash:` (2026-10-29, a full-access key added in Meteor Wallet). `parse.ts` now matches `ml-dsa-`, and the fixtures use the real prefix | the owner's testnet wallet account | final (not recorded) |
| 4 | `GENESIS_HEIGHT` mainnet 9820210, testnet 42376888 | confirmed (2026-10-29, `EXPERIMENTAL_genesis_config`: testnet 42376888, mainnet 9820210) | n/a (no account) | n/a (genesis config) |
| 5 | `policy.rs` permission matching and vote-policy fallback | confirmed (2026-10-29): the `council` role has permissions `["*:*"]` and the scan reported `can_approve_transfer: true`. Its empty `vote_policy` `{}` falls back to `default_vote_policy` (RoleWeight, ratio 1/2, quorum 0) | `verdict-panel-p8n6.sputnik-v2.testnet` (third-party testnet DAO, council of 2) | 275337332 |
| 6 | `to_weight` formula | confirmed (2026-10-29): ratio 1/2 with 2 members gives min(1·2/2 + 1, 2) = 2, quorum 0, and the scan reported `approvals_needed: 2` | `verdict-panel-p8n6.sputnik-v2.testnet` | 275337332 |
| 7 | `DEFAULT_RPC_URL` values answer JSON-RPC | confirmed (2026-10-29, `block` with `finality: final`) | n/a (no account) | testnet 275336292, mainnet 222159657 |

## GĐ5 live-run checklist (`checkProposals`)

These are recalled Sputnik v2 facts that `src/proposals.ts` depends on. The owner checks them on a testnet DAO with at least one proposal. GĐ5 is "built", not "done", until all four are recorded.

| # | Recalled value | Status | DAO | Block height |
|---|---|---|---|---|
| 1 | `get_last_proposal_id` is the proposal count: the newest id is `last - 1`, and `get_proposal {"id": last}` fails | unconfirmed | | |
| 2 | `get_proposal` JSON: `id`, `proposer`, `description`, `kind` (externally tagged, e.g. `{"Transfer": {...}}`, unit variants as a string), `status`, `votes` (`{account: "Approve" \| "Reject" \| "Remove"}`) | unconfirmed | | |
| 3 | Status values: `InProgress`, `Approved`, `Rejected`, `Removed`, `Expired`, `Moved`, `Failed` | unconfirmed | | |
| 4 | Kind → label map in `KIND_LABEL` (`Transfer` → `transfer`, `FunctionCall` → `call`, `ChangePolicy*` → `policy*`, `UpgradeSelf` → `upgrade_self`, ...) | unconfirmed | | |
