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

## 2026-11-12: DAO price floor (red-team H2)

**Problem.** Anyone can call `execute_plan_step` (ADR 0005 K2), and Decision 4 set `min_out` from a spot quote read in the same step. An attacker could move pool 57 just before calling the step, let the Guard quote the skewed price, then move it back: a sandwich that sells the DAO's NEAR cheap with the slippage check passing.

**Decision** (owner, 2026-11-12):

| # | Decision |
|---|---|
| 10 | New `PlanAction::SwapWithFloor { pool_id, token_out, max_slippage_bps, min_out_per_near }`, appended last (borsh order kept, no `migrate` change). JSON tag `swap_with_floor`. `min_out_per_near` is `token_out` base units per whole NEAR (10^24 yocto), set by the DAO when it votes the plan. |
| 11 | `create_plan` refuses `swap` (`PRICE_FLOOR_REQUIRED`) and a zero floor (`INVALID_PRICE_FLOOR`). |
| 12 | In `on_quote`: `dao_floor = amount_per_run × min_out_per_near / 10^24` (256-bit, no overflow). If `quote × (10000 − bps) / 10000 < dao_floor`, or `dao_floor` does not fit in `u128`, the run is skipped: no proposal, the request is saved `Failed`, the daily limit is given back, `runs_done` does not move, the slot moves on, and `plan_step_skipped { plan_id, run, reason: "PRICE_BELOW_FLOOR", due }` is emitted. Otherwise `min_out = max(quote_floor, dao_floor)`. |
| 13 | A plan made with the old `swap` pauses with the new `PlanPauseReason::PriceFloorRequired` (appended last) and code `PRICE_FLOOR_REQUIRED`: when it comes due, and also when its quote was in flight at the upgrade. The DAO cancels it and creates it again with a floor. |
| 14 | Guard version 1.5.0. |
| 15 | The dashboard asks for a "lowest price" in USDT per NEAR, prefilled 5 % under the current Rhea quote and editable; code turns it into base units with the token's 6 decimals. Below 1.5.0 the dashboard asks for the Budget update before a DCA. |

**Why a new tag, not a field on `swap`.** A 1.4.0 Guard ignores unknown JSON fields, so a `swap` with a floor sent to a Guard that has not upgraded would create a plan with no floor and no error. `swap_with_floor` fails loudly on such a Guard.

**Consequences.** A sandwich can now only make a run skip, never sell under the DAO's floor. A floor set too high makes every run skip until the DAO changes the plan; the review step warns when today's price is already below it. Existing swap plans stop until recreated. The `kd.budget_alert.v1` `Plan` action gains an additive variant.
