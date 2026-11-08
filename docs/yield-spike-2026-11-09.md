# YD0 yield spike: a DAO supplies to Rhea Lend and gets it back (testnet)

Plan: [yield plan YD0](stories/epics/yield/plan.md). Script: [`scripts/yield-setup/spike.sh`](../scripts/yield-setup/spike.sh).
Status: **live run passed on 2026-11-09** (DAO `kdy1794161239.sputnik-v2.testnet`, signer `duonghb3.testnet`). Script written and dry-run on 2026-11-08.

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

## Results (live run, 2026-11-09)

Gas burnt is the transaction plus all its receipts, read from `EXPERIMENTAL_tx_status`. Every transaction below has 0 failed receipts.

| Step | Proposal id | Status | Tx hash | Gas burnt | Notes |
|---|---|---|---|---|---|
| dao | – | created | `7i8CtC1NpZRdAQfUyiVncsiBcxSR52hu59AeLaxpr8g2` | 77.6 Tgas | `kdy1794161239.sputnik-v2.testnet`, council `duonghb3.testnet` only, 6 NEAR attached |
| fund | – | done | `nuMkjKDXJdv1dbDr6o92SF6F2rX5MYmjTJZJwqLF6ea` (storage), `6F5e5vkLQrxuQEK1ZiJFB86EQTPdnaSQYe5zizcNi4dS` (mint 20) | 2.3 Tgas (mint) | DAO token balance `20000000` (20 USDC.e) at block 276810740 |
| extra mint (by hand) | – | done | `58JE1zTr3pNbgALn9kfnkfCc42UQmfLxsqbAWUNWbRm9` | 2.3 Tgas | `mint` 2,000,000 USDC.e to the DAO. Balance `2000020000000` at block 276811435 |
| register (`storage_deposit`, 0.1 NEAR) | 0 | Approved | add `BcKUGV5oZT4Qwxw7eNS9pvWYPbrJThNMoKDhWuJEHKZr`, vote `No6ZwFfjJKk9u1MVVuusuGP4rbYfc3RB8xLtPihff8W` | 2.7 + 7.0 Tgas | Rhea Lend lists the DAO with `{"supplied":[],"collateral":[]}` |
| supply (`ft_transfer_call`, `msg: ""`) | 1 | Approved | add `Eviu7fgsREzbCoKvyupJSxRFzkZu2DfnFJgjfcPRykSK`, vote `FsSHaXvgUNQZQoz8zsWUX5gZUcBEDq5hfoHZUAUPCE64` | 2.7 + 13.3 Tgas | `KD_YIELD_AMOUNT=2000000000000` (2M). Supplied balance on Rhea Lend `2000000002638116083094016` (18 decimals: token 6 + `extra_decimals` 12), `collateral` empty. Supply APR fell from 0.1055 to 0.0023 after this supply |
| withdraw (`execute` `[Withdraw]`, no `max_amount`) | 2 | Approved | add `A7xnY8E7Yg8uDfaxwJeagnbUaQxiDupk4xc9ocFxuZwU`, vote `Arpj3DYEwEj73759eyycNsC2pgg4AWVvJPizXReWEx11` | 2.7 + 14.7 Tgas | No oracle call needed. Event `withdraw_succeeded` for `2000000009655415153633413`. DAO balance after `2000020009655` (+0.009655 USDC.e interest). Rhea Lend shows no supply |

Done when: the withdraw proposal is Approved, the DAO's token balance is at least the supplied amount, and Rhea Lend shows no supplied balance for the DAO.

## Answers from the run

- `msg: ""` supplies without collateral, and Withdraw needs no oracle prices: yes.
- 150 Tgas is enough for `ft_transfer_call` and `execute` under a 300 Tgas vote: yes, the whole vote burnt 13.3 and 14.7 Tgas.
- Does a proposal show `Failed` when Rhea Lend rejects the call? Not answered: every call passed. Sputnik marks a proposal Approved even when the call fails, so the proposal job must not trust the status alone.
- A big supply moves the APR of this test pool a lot (0.1055 to 0.0023). Suggestions should read the APR at the time of the scan.
- `spike.sh status` fails on a DAO with no proposal yet: it calls `get_proposal` with id `-1`.
