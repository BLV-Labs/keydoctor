# Trezu integration

Status: **compatibility checked once, read-only. Not a shipped feature.** Spike run 2026-10-30.

## Summary

- Trezu is a treasury app for NEAR DAOs. Public treasuries are Sputnik DAO accounts (`*.sputnik-dao.near`) on mainnet.
- Key Doctor's `scanDao` and `checkProposals` ran on one public Trezu treasury without code changes.
- Trezu has no testnet. The demo, fixtures and README steps cannot use a Trezu treasury, so this is not reproducible by a judge.
- Decision: do not list Trezu under features. Keep it under Roadmap / Limitations until a reproducible path exists.

## What the spike checked

| Check | Result |
|---|---|
| `scanDao` on a public mainnet treasury | Ran. Network inferred from the account id, policy and council parsed. |
| Policy roles | Parsed as Sputnik v2 groups (`Create Requests`, `Manage Members`, `Vote`). `can_approve_transfer` correct. |
| `checkProposals` with `prev = null` | Ran. Recorded the last proposal id, no alerts, no errors. |
| Writes | None. RPC reads only. No D1, no repo files. |

## What is not verified

- Whether Trezu uses stock Sputnik DAO v2 or a modified contract. Docs and repo do not say.
- Confidential treasuries. Where their data lives is unknown, so the scanner may see nothing.
- More than one treasury. Other policies (custom roles, vote thresholds, bounties) are untested.
- NEAR Business. Invite-only, mainnet only, confidential option. Out of scope.

## Known gap found

- A council member with more than 100 access keys makes RPC `view_access_key_list` fail with `TOO_MANY_ACCESS_KEYS` (limit 100).
- The scan handles it as designed: `members[].error = "RPC_ERROR"`, the scan continues.
- The user-facing message says "Could not read chain data right now". That is misleading here, because the failure is permanent for that account. Candidate fix: a dedicated error code and message. Not done.

## Rules this integration must respect

- Examples, fixtures and the demo use testnet accounts only. Do not add real mainnet treasury or member names to the repo.
- No account leaderboards.
- The scanner never signs or holds keys. A treasury app does not change that.

## Options

| Option | Effort | Reproducible | Note |
|---|---|---|---|
| A. Document only (current) | Low | No | One line under Roadmap / Limitations. Recommended. |
| B. Testnet Sputnik DAO with a Trezu-like policy | Low | Yes | Same three roles. Proves nothing specific to Trezu. |
| C. Allow one read-only mainnet example in the README | Low | Yes | Needs a change to the testnet-only rule. Human decision. |
| D. Trezu-specific features (bulk payments, confidential) | High | Unknown | No spec, no API knowledge. Out of the build window. |

## Suggested README wording (Roadmap / Limitations)

> Trezu treasuries are Sputnik DAOs. A one-off read-only scan of a public mainnet treasury parsed correctly. Trezu has no testnet, so this is not part of the demo and is not reproducible here.

## Sources

- Trezu repo: https://github.com/olskik/trezu
- Trezu site and docs: https://trezu.org, https://docs.trezu.org/
- Spec: `docs/final-idea.md` §14 (track hints), §15 (Roadmap)
