# 0007 — DCA swap step in the Guard

- **Date**: 2026-11-09
- **Status**: Accepted
- **Deciders**: owner, 2026-11-09 (D1, D2, D3, D7 in `docs/stories/epics/guard/gd31-dca-plan.md` §9)
- **Spec**: `docs/final-idea.md` §11.11.3 (DCA step 4c), §11.11.4 (checklist); builds on ADR 0005 (keeper key) and ADR 0006 (plan actions, upgrade)

## Context

GĐ31 sells NEAR for USDT on Rhea (`ref-finance-101.testnet`, pool 57) on a schedule. The keeper runs the step, so the step must stay inside ADR 0005: the keeper passes only `plan_id` and holds no privilege. Facts that shape the design:

- `PlanAction` had `Transfer` and `Call`. A swap needs a `min_amount_out` that is only known at run time, so the vote's `proposal` arg cannot be rebuilt from the stored plan.
- The installed Sputnik attaches no callback to a `FunctionCall`. A swap that Rhea refuses still shows `Approved`, and the Guard reads the request as `Executed`.
- The factory stored the Guard code once, in `new`, with no setter.
- The Budget is a DAO. Anything it pays for or registers goes through a DAO vote.

## Decision

| # | Decision |
|---|---|
| 1 | Add `PlanAction::Swap { pool_id, token_out, max_slippage_bps }` as the last variant, so the old state still decodes and `migrate` does not change. Guard version 1.3.0. |
| 2 | The wrap and exchange ids come from a network constant (`dex_for`), read from the Guard's own account suffix. Testnet only; off testnet `create_plan` refuses a swap with `SWAP_NOT_SUPPORTED`. |
| 3 | Slippage is 50, 100 or 200 bps (0.5 / 1 / 2 %), the same three choices the form offers. `token_out` cannot be the wrap, the exchange, the Guard, the DAO or the factory. |
| 4 | The quote runs inside the step: `execute_plan_step` → `get_return` → `on_quote` (`#[private]`) → `add_proposal` → `on_proposal_added(request_id, Some(kind))` → `act_proposal`. `min_out = quote × (10000 − bps) / 10000`. A failed or zero quote pauses the plan with `QUOTE_FAILED` and gives the daily window back. |
| 5 | The proposal is one `FunctionCall` on the wrap: `near_deposit` then `ft_transfer_call` to the exchange with the swap `msg`. `ft_transfer_call` gets 150 Tgas; the keeper attaches 300 Tgas to the step. |
| 6 | A swap refused at Rhea counts as a run on chain. The Worker reads the step's transaction, finds the Rhea receipt, and reports `SLIPPAGE` in Telegram and the step history. The NEAR stays in the DAO as wNEAR (owner D2). |
| 7 | Enable USDT is DAO requests: one `storage_deposit` `FunctionCall` per contract that is not yet registered, two signatures in all (add batch, vote batch), then a chain read-back (owner D3). |
| 8 | The factory gets `set_guard_code` (`#[private]`, borsh wasm) and stays the `code_source` for `upgrade`. New Budgets start on 1.3.0; existing ones upgrade from the factory by DAO vote (owner D1). |
| 9 | The form accepts runs or an end date. An end date becomes `runs_total = floor((end − start) / interval) + 1`; the contract sees only runs (owner D7). |

## Alternatives Rejected

- **Exchange ids per plan or in Guard config**: more fields and a check with no gain. Only the DAO creates plans, and the DAO can already call anything (ADR 0006 D3). The keeper never passes them either way.
- **Quote from the Worker, passed into the step**: the keeper would steer `min_amount_out`, which breaks K2 in ADR 0005.
- **Guard callback on the swap result**: not possible. Sputnik attaches no callback to a `FunctionCall`, so the Guard never sees the Rhea outcome.
- **Owner's wallet pays storage for USDT**: the Budget is a DAO; money and registrations go through its vote.
- **New code-source account for 1.3.0**: one more account to trust and fund. The factory already serves `get_guard_code`.
- **End date in the contract**: a state change and a `migrate` for something the form can turn into a run count.

## Consequences

**Positive**:
- No new keeper privilege. The keeper still signs only `execute_plan_step` with a `plan_id`.
- A refused swap loses nothing: Rhea refunds, and the wNEAR stays in the DAO.
- Existing Budgets get DCA by upgrade, without moving funds.

**Tradeoffs**:
- A slippage refusal still counts as a run and against the 24-hour limit, so the plan ends with one sell fewer. The Worker's report is the only place the owner sees it.
- The refunded NEAR stays wrapped; unwrapping it is a separate DAO request.
- Gas: `on_quote` gets 210 Tgas inside the keeper's 300. If `ft_transfer_call` needs more than about 200 Tgas, the step cannot fit and GĐ31 takes the cut path (plan D10).
- The swap result comes from Rhea's log format, which the Worker parses. If the format changes, the step still shows as executed, but with no USDT figure and no price.
- Withdrawing USDT is not built yet (Roadmap). The USDT stays in the DAO.

**Revisit trigger**: mainnet support, a second exchange, or a Sputnik version that calls back on a `FunctionCall`.
