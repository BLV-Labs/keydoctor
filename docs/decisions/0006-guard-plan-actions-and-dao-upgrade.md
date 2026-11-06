# 0006 — Guard plan actions and DAO-only upgrade

- **Date**: 2026-11-06
- **Status**: Accepted
- **Deciders**: owner, 2026-11-06 (asked for the spec update)
- **Spec**: `docs/final-idea.md` §4.11, §11.5.12, §11.10.5, §11.11.2

ADR 0005 stays reserved for the keeper key (§11.11.5).

## Context

The roadmap adds strategies, and possibly a yield agent, on top of Agent Budget. Three facts shape how:

- A factory Guard has no key, and the spec said new Guard code meant a new factory and a **new Budget**. Every new strategy would force users to move their money.
- `PlanKind` hardcoded `payout | dca`, so each strategy needed contract code.
- A sandbox test against the Sputnik code that `sputnik-v2.testnet` installs showed `act_proposal` ignores its `proposal` argument (B-Q7). The same wasm contains `upgrade_remote`, `store_blob` and `remove_blob`, but `upgrade_remote` cannot carry a Guard (B-Q10, see Decision 5).

## Decision

| # | Decision |
|---|---|
| 1 | Keep one Guard instance per Budget, built from one shared code base. |
| 2 | A plan holds a `PlanAction`: `transfer`, `call` or `swap`. A strategy that fits an existing action is a dashboard template, not contract code. |
| 3 | `create_plan` refuses a `call` whose target is the Guard, its DAO or the factory. The Guard keeps no contract allowlist, because only the DAO creates plans and the DAO can already call anything. |
| 4 | Every plan step counts `amount_per_run` against the 24-hour limit, including a `call` that keeps funds in the DAO's name. The Guard cannot read what args mean. |
| 5 | The Guard gets `upgrade(code_source, code_hash)`, callable only by `dao_id`, reached through a DAO `FunctionCall` proposal. The Guard pulls the wasm from `code_source.get_guard_code()`, checks its sha256 against the hash the DAO voted on, then deploys and runs `migrate` in one batch. The source needs no trust. Changed 2026-11-06: the first version used `UpgradeRemote`, which runs out of gas above about 150 KB because the installed Sputnik keeps about 10 Tgas after attaching the rest; the Guard wasm is 252 KB. |
| 6 | Owner actions that create a proposal take two signatures: `add_proposal`, read the id from the return value, compare the content, then `act_proposal`. Only sign 2 of Budget creation stays batched. |

## Alternatives Rejected

- **One singleton contract for all agents**: a bug hits every Budget, upgrades need a team key with power over every Budget, and it breaks the `dao_id = predecessor` lock and the per-Guard function-call key.
- **Stay non-upgradable, ship factory `-v3` per feature**: every user recreates their Budget and moves funds.
- **Strategy config in the Worker**: a leaked keeper key would then control amounts and receivers, which voids the "no privilege" condition of the keeper exception.
- **Adapter contracts per protocol**: more moving parts than two strategies need. Revisit at the third protocol that needs runtime logic.
- **`UpgradeRemote`**: measured in the sandbox, fails with "Exceeded the prepaid gas" for a Guard-sized wasm.
- **Staging the code on the Guard in chunks**: too many signatures.
- **Wasm as `FunctionCall` args**: leaves a permanent 250 KB proposal in the DAO.
- **Global contracts**: about 25 NEAR per release.
- **Keep one signature with a guessed id**: can approve an agent's over-limit proposal, because nothing checks the content.

## Consequences

**Positive**:
- Budgets created today can take plans (GĐ29) and token limits (GĐ23) later without moving funds.
- New fixed-call strategies need no contract work.
- A bad upgrade cannot lose funds: they sit in the DAO, and the owner can still withdraw by proposal.

**Tradeoffs**:
- The Guard is no longer immutable. "Locked" now means no key can change the code; the DAO still can. The Key Doctor `code_upgrade_proposal` alert covers this, including a `FunctionCall` to `upgrade`.
- For a multi-member DAO, a passed council vote can replace the Guard.
- Withdraw and rule edits cost two signatures instead of one.
- `migrate` must be written and tested for every state change.
- The installed Sputnik attaches no callback to a `FunctionCall`, so a failed upgrade still shows `Approved`. The dashboard must read the Guard's `code_hash` back.
- Each release needs a deployed factory holding the code, which is the `code_source`.

**Revisit trigger**: mainnet `sputnik-dao.near` code checks `proposal` (one signature becomes possible again), or a third protocol needs runtime logic.
