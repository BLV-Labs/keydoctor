# Fixtures

Sample data for tests and for building the dashboard before the scanner exists. Testnet names only; every public key is random bytes, not a real key.

| Folder | Contents | Status |
|---|---|---|
| `reports/` | `kd.report.v1` for DAO `kd-demo.sputnik-dao.testnet` (one member each at `high`, `cleanup`, `ok`) and for account `b.kd-demo.testnet` | Hand-built to the §4.1 contract |
| `alerts/` | `kd.alert.v1` `voter_new_full_access_key` for proposal 2 | Hand-built to the §4.4 contract |
| `rpc/` | Raw `view_access_key_list` JSON-RPC responses | Shape from the NEAR RPC docs |
| `corpus/` | One positive and one negative scan case per rule (26 files) plus `LIMIT_NON_GROUP_ADMIN.json`; see below | Hand-built; run by `test/corpus.test.ts` |
| `sputnik/` | Decoded results of Sputnik v2 `get_policy`, `get_last_proposal_id`, `get_proposal` | **Not yet checked against a live testnet DAO** (`docs/final-idea.md` §13.5) |

Known placeholders, to replace in GĐ1/GĐ5 with data captured from testnet:

- The ML-DSA public key prefix `mldsa65:` is a guess. Check the real prefix NEAR RPC returns.
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

Owner runs `packages/key-doctor/scripts/scan.ts --save-raw`. Only that run changes a status to `confirmed` or `differs: <value>`, and it records the account or DAO name and the block height. GĐ1 is "built", not "done", until all seven are recorded.

| # | Recalled value | Status | Account or DAO | Block height |
|---|---|---|---|---|
| 1 | Cause names `UNKNOWN_ACCOUNT`, `UNKNOWN_BLOCK`, `NO_CONTRACT_CODE`, `CONTRACT_EXECUTION_ERROR` | unconfirmed | | |
| 2 | An empty key list (not `UNKNOWN_ACCOUNT`) for a missing account | unconfirmed | | |
| 3 | `mldsa65:` key prefix | unconfirmed | | |
| 4 | `GENESIS_HEIGHT` mainnet 9820210, testnet 42376888 | unconfirmed | | |
| 5 | `policy.rs` permission matching and vote-policy fallback | unconfirmed | | |
| 6 | `to_weight` formula | unconfirmed | | |
| 7 | `DEFAULT_RPC_URL` values answer JSON-RPC | confirmed (2026-10-29, `block` with `finality: final`) | n/a (no account) | testnet 275336292, mainnet 222159657 |
