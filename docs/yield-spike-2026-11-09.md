# YD0 yield spike: a DAO supplies to Rhea Lend and gets it back (testnet)

Plan: [yield plan YD0](stories/epics/yield/plan.md). Script: [`scripts/yield-setup/spike.sh`](../scripts/yield-setup/spike.sh).
Status: script written and dry-run on 2026-11-08 (every proposal JSON builds, read-only checks pass). **The live run has not happened yet.** It needs the owner to sign.

## Read-only facts (checked 2026-11-08 over testnet RPC)

| Fact | Result |
|---|---|
| Rhea Lend contract | `contract.1638481328.burrow.testnet`, code hash `7b2DjxtjCHJA5wDRgpMEQVRp2qUTZrL8eZWLkE9wrxXh`, oracle `priceoracle.testnet` |
| `usdc.fakes.testnet` on Rhea Lend | `can_deposit` and `can_withdraw` true, `extra_decimals` 12, `supply_apr` 0.1053 (test data), no supply farm reward |
| Token | `usdc.fakes.testnet`, 6 decimals, metadata symbol `USDC.e` (a test token, not bridged USDC) |
| Who may `mint` | Anyone. Unrelated accounts called `mint({account_id, amount})` with 0 deposit and 30 Tgas, and it succeeded (for example tx `6pF43rR56aqoZa4LkStTF3c47VTgmP8G6a9EAQoDXPLC`, 2026-11-07). The wasm exports no `owner_id` |
| Storage | Rhea Lend `storage_balance_bounds.min` 0.1 NEAR. Token storage 0.00125 NEAR |
| NearBlocks | API v1 was retired on 2026-11-05. v3 works at `/v3/accounts/<id>/txns`. Its `method` and `page` filters were ignored in this check |

## Steps to run (owner)

```bash
export KD_YIELD_MEMBER=<your older testnet account> KD_YIELD_PREFIX=kdy$(date +%s)
scripts/yield-setup/spike.sh check
scripts/yield-setup/spike.sh dao
scripts/yield-setup/spike.sh fund
scripts/yield-setup/spike.sh propose-register && scripts/yield-setup/spike.sh approve && scripts/yield-setup/spike.sh status
scripts/yield-setup/spike.sh propose-supply   && scripts/yield-setup/spike.sh approve && scripts/yield-setup/spike.sh status
scripts/yield-setup/spike.sh propose-withdraw && scripts/yield-setup/spike.sh approve && scripts/yield-setup/spike.sh status
```

## Results (fill in after the live run)

| Step | Proposal id | Status | Tx hash | Gas burnt | Notes |
|---|---|---|---|---|---|
| dao | – | | | | |
| fund | – | | | | |
| register (`storage_deposit`, 0.1 NEAR) | | | | | |
| supply (`ft_transfer_call`, `msg: ""`) | | | | | Supplied balance on Rhea Lend: |
| withdraw (`execute` `[Withdraw]`, no `max_amount`) | | | | | Oracle call needed? DAO balance after: |

Done when: the withdraw proposal is Approved, the DAO's token balance is at least the supplied amount, and Rhea Lend shows no supplied balance for the DAO.

## Open questions the run answers

- Does `msg: ""` supply without collateral, so that Withdraw needs no oracle prices?
- Is 150 Tgas enough for `ft_transfer_call` and `execute` when a 300 Tgas vote executes them?
- Does a proposal show `Failed` when Rhea Lend rejects the call, so that the proposal job reports it?
