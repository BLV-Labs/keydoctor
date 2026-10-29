# 0002 — GĐ1 rule set reading

- **Date**: 2026-10-29
- **Status**: Accepted 2026-10-29
- **Deciders**: per item, as marked below
- **Story**: `docs/stories/epics/library/gd1-scan/`

## Context

`docs/final-idea.md` §5.1 (`:523-539`) lists the 13 rules, but it leaves gaps. It does not define a DAO admin or the block time for key age. It also leaves open a missing council member, a council size cap, and the overlap of `FA_MANY` and `FA_MULTIPLE`. The GĐ1 design (`docs/design/gd1-scan.md` §4 to §9) needs one reading for each gap before code.

## Decision

| # | Reading | Design | Decider |
|---|---|---|---|
| 1 | All 3 T5 rules ship. `FA_BOT_LIKE` fires at 1000 uses (`FA_BOT_LIKE_USES`). | §6 | owner, 2026-10-29 |
| 2 | `DAO_ADMIN` is a member who can pass a policy proposal alone. The role matches `L:VoteApprove` for an admin label `L`, with `approvals_needed(role, L) === 1`. | §4 | owner, 2026-10-29 |
| 3 | Key age uses a constant 1.2 s block time (`BLOCK_TIME_MS = 1200`). | §5 | owner, 2026-10-29 |
| 4 | A missing council member gets status `note`, no flag, and one limitation line. The 13 rules stay frozen. | §3, §6 | owner, 2026-10-29 |
| 5 | A council of 22 or more throws `LIMIT_EXCEEDED` (`MAX_MEMBERS` 21). A partial scan goes to the Roadmap, and the GĐ14 README lists the cap under Limitations. | §9 item 9 | owner, 2026-10-29 |
| 6 | No per-member callback in GĐ1. Every member goes through the pure `buildMember()` seam, so GĐ7 can add an optional `ScanOptions` field later. | §2 | orchestrator, on the red-team's side |
| 7 | `members_ok` counts members with status `ok` or `note`, so `members_high + members_cleanup + members_ok = members_scanned` (`docs/final-idea.md:311`). | §7 | orchestrator |
| 8 | `FA_MANY` suppresses `FA_MULTIPLE`. `MAX_ROLES` is 50 per policy. `MAX_KEYS` is 100 per account. | §6, §9 | Lead Dev design. Decider unchecked for the owner. |

## Alternatives Rejected

- **Admin = any member of a role that can vote on policy**: it flags every council member of a normal multisig. The flag then loses meaning.
- **Key age from real block timestamps**: it costs one extra request per key and breaks the per-scan request budget.
- **A new rule for a missing member**: it changes the frozen 13-rule set and `ruleset_version`.
- **A partial scan of a large council**: a partial result reads as a full one. A loud error is safer for the hackathon build.
- **A per-member callback now**: it widens the GĐ1 API before any consumer needs it.
- **`members_ok` = status `ok` only**: the sum in `docs/final-idea.md:311` would not hold when a member has only note flags.

## Consequences

**Positive**:
- Every threshold and cap is a named export of `rules/thresholds.ts`. A change bumps `RULESET_VERSION`.
- The status of a council stays its weakest member's level.

**Tradeoffs**:
- Age is an estimate. The limitation line says so in every report.
- A DAO with more than 21 council members gets no report in GĐ1.
- Item 8 has no owner ruling. The owner can override it, which bumps `RULESET_VERSION`.

**Revisit trigger**: the owner rules on item 8. Or the §11 live run shows a different block time or policy rule. Or a target DAO has more than 21 council members.
