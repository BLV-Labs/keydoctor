# 0005 — Unprivileged keeper key in the Worker

- **Date**: 2026-11-06
- **Status**: Proposed
- **Deciders**: pending owner approval
- **Spec**: `docs/final-idea.md` §11.11.3, §11.11.5, T16; `docs/usecase.md` UC18

Items marked *(added)* go beyond §11.11.5. They came out of writing this ADR and need the same approval.

## Context

A plan in a Guard (ADR 0006) runs on a schedule, and a NEAR contract cannot wake itself: someone has to send a transaction to `execute_plan_step(plan_id)` when a step is due, and to `sync_request` to settle requests. GĐ29 gives that job to the Worker cron, so the Worker has to sign.

Today's invariant forbids this: "The Worker never holds a key". The Guard emergency brake (GĐ24) was cut for that reason (plan D4). The brake key was privileged, because its reporter account could vote to reject proposals. A keeper needs no privilege: `sync_request` already accepts any caller, and `execute_plan_step` can be built the same way.

State of the code: `sync_request` exists, `execute_plan_step` does not yet, and the Worker has no signing code.

## Decision

Accept one conditional exception: the Worker holds exactly one key, the key of a keeper account that has no privilege anywhere. Violating any one condition voids the exception.

| # | Condition | Checked by |
|---|---|---|
| K1 | No contract grants the keeper any special right: no whitelist entry, role, or keeper-only method | Code review; a new rule that the DAO policy has no keeper member; the dashboard refuses the keeper as whitelist entry or plan receiver *(added)* |
| K2 | `execute_plan_step` and `sync_request` do not distinguish the caller. Only the due step runs, extra calls are refused | Tests: a stranger gets the same result as the keeper; an early call is refused; a double call runs the step once |
| K2a *(added)* | The caller also picks the attached gas. A call with too little gas fails and leaves the plan untouched, so no run can be burnt. Both methods take no deposit | Test: a low-gas call changes neither `runs_done` nor `next_run_at`; all promise gas stays static, as in the Guard today |
| K3 | The Worker holds this one key only, and none of a user, agent, Guard or DAO | Review of the Worker config: `KEEPER_PRIVATE_KEY` is the only key-type secret |
| K4 | The keeper account holds a small balance. The Worker warns the team below the minimum | `KEEPER_MAX_BALANCE`, `KEEPER_MIN_BALANCE` (example: 5 and 1 NEAR on testnet) |
| K5 | The key lives in a Worker secret, never in the repo or a log, and a rotation procedure exists | Review; rotation steps in the ops README |

The key is a full-access key of the keeper account. A function-call key binds to one receiver, each Budget has its own Guard, and the account holds nothing worth protecting beyond K4's balance.

The CLAUDE.md invariant changes, once this ADR is accepted, to: *"The Worker never holds a key that has any privilege. The only key it holds is the unprivileged keeper key (ADR 0005)."*

Scope of the approval *(added)*:

- It covers automatic signing by the Worker of these two methods only. Every other signing or spending still needs human confirmation.
- Creating, funding and rotating the keeper account stay owner tasks.
- Testnet only. Mainnet needs a new decision.
- It does not reopen GĐ24: the brake key is privileged and fails K1.

## Alternatives Rejected

- **A function-call key per Guard for the keeper's public key**: the Worker still holds the private key, so the invariant is not solved, and every Guard gets more complex.
- **Trigger from the owner's machine** (Guard MCP on a schedule, or due steps run when the dashboard opens): keeps the invariant, but plans stop when the machine is off.
- **External scheduler holding the key** (such as a GitHub Actions cron) *(added)*: moves the key elsewhere without lowering the risk, and its timing is less reliable than the Worker cron.

## Consequences

**Positive**: plans run on time with no owner machine online. A leaked key alone cannot move funds, change rules or block proposals, since it can do nothing that any account cannot do.

**Tradeoffs**:

- A leaked key loses the keeper balance. *(added)* The holder can also delete the account or replace its key, so plans stop until a new keeper is configured. Plans stay intact, and anyone can still call the methods.
- This claim covers the key alone. A full Worker compromise also exposes the Worker's other secrets, as it does today.
- *(added)* The risk below comes from the public method, not the key, and exists with or without a keeper. Any caller picks when a due step runs inside its window. That can reach the skip (`OVER_DAILY_LIMIT`) or pause (`guard_low_near`) outcomes: no funds move, but a run can be missed or a plan paused.
- *(added)* For swaps (GĐ31), a caller can time the call to a pushed pool price. `min_out` comes from that same price in the transaction, so `max_slippage` does not fully bound the loss. The real bound is the per-run size.
- *(added)* K1 cannot be enforced by contract: a DAO can add the keeper as a member by its own vote. Its check needs a new rule, and the `GUARD_*` rules (GĐ20) are not in the code yet.
- Steps run up to 15 minutes late (cron interval).

**GĐ29 implementation notes** *(added)*:

- The Worker needs signing code. Ed25519 on Workers and the free-plan CPU limit must be measured, not assumed.
- One key means sequential nonces, so cron cycles must not overlap. A retry is safe under K2.
- The keeper finds Guards through the factory `list_guards`, so a Budget with no subscription still runs. Messages still need a subscription.

**Revisit trigger**: any feature that needs a keeper-only right, a second key in the Worker, a move to mainnet, or a scheduler on NEAR that removes the need for a keeper.
