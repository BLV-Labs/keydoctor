# Fixtures

Sample data for tests and for building the dashboard before the scanner exists. Testnet names only; every public key is random bytes, not a real key.

| Folder | Contents | Status |
|---|---|---|
| `reports/` | `kd.report.v1` for DAO `kd-demo.sputnik-dao.testnet` (one member each at `high`, `cleanup`, `ok`) and for account `b.kd-demo.testnet` | Hand-built to the §4.1 contract |
| `alerts/` | `kd.alert.v1` `voter_new_full_access_key` for proposal 2 | Hand-built to the §4.4 contract |
| `rpc/` | Raw `view_access_key_list` JSON-RPC responses | Shape from the NEAR RPC docs |
| `sputnik/` | Decoded results of Sputnik v2 `get_policy`, `get_last_proposal_id`, `get_proposal` | **Not yet checked against a live testnet DAO** (`docs/final-idea.md` §13.5) |

Known placeholders, to replace in GĐ1/GĐ5 with data captured from testnet:

- The ML-DSA public key prefix `mldsa65:` is a guess. Check the real prefix NEAR RPC returns.
- Sputnik `kind` labels, `vote_counts` and `submission_time` formats must be compared with the contract source.
- `created.at` and `age_days` assume a 1.2 s block time; the real scanner reads block timestamps.
