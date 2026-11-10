# GĐ31 plan: DCA NEAR → USDT through Rhea

- **Spec:** `docs/final-idea.md` §11.11.3 (branch 4c), §11.11.4, §11.10.5 (Enable USDT), §4.11 types, §9.5 DCA message, §13.8 row 31 ("2 sells on testnet with USDT received and a Telegram message").
- **Spike:** `docs/dca-spike-2026-11-09.md`: `ref-finance-101.testnet`, pool 57, `wrap.testnet`, `usdt.fakes.testnet` (6 decimals), 0.1 NEAR per run.
- **Base:** `main` at `8471b65`. Guard 1.2.0 (`contracts/guard/src/lib.rs:685`). (Superseded 2026-11-10: 1.3.0 added swaps, 1.4.0 added `close`; the line refs here are of that base.)
- **Status:** built (S1–S6) and merged to main; live 2-sell run passed on `payroll-2` 2026-11-09 (backlog O9). Guard is now 1.4.0 (`close`, 2026-11-10, O11). Owner decisions taken 2026-11-09 (§9): D1 (b) update the factory, D2 accept, D3 (b) DAO route, D7 add the end date. The rest follow the Lead recommendation.

## 0. Facts the plan rests on (read in the code)

| # | Fact | Where |
|---|---|---|
| F1 | `PlanAction` has `Transfer` and `Call` only. A `swap` input does not parse | `contracts/guard/src/types.rs:109-122` |
| F2 | `execute_plan_step` moves the slot and counts `amount_per_run` in its first receipt, then calls `add_proposal` → `on_proposal_added` → `act_proposal` → `on_voted` | `lib.rs:372-441`, `lib.rs:204-256` |
| F3 | `on_proposal_added` rebuilds the vote's `proposal` arg from the stored plan (`plan_kind`). A swap kind holds a `min_amount_out` known only at run time, so it cannot be rebuilt | `lib.rs:226-229`, `lib.rs:880-887` |
| F4 | `runs_done` moves when the Guard's vote succeeds. A DAO short of NEAR fails the vote receipt, because the attached deposit leaves inside `act_proposal` | `lib.rs:773-812` |
| F5 | The installed Sputnik attaches no callback to a `FunctionCall`, so a swap that fails at Rhea still shows `Approved` and `sync_request` reads `Executed` | ADR 0006 Consequences, `lib.rs:271-292` |
| F6 | Today's Guard role holds `transfer:AddProposal`, `transfer:VoteApprove` only. A `call` or swap step fails its vote | `apps/dashboard/src/guard-proposals.ts:7-8`, backlog C12, sandbox `a_call_plan_without_the_call_right_pauses_at_its_first_step` |
| F7 | The factory stores the Guard code once, in `new`. It has no setter. A Guard upgrades through a DAO `FunctionCall` to `upgrade(code_source, code_hash)`. The Guard pulls `get_guard_code` from any account and checks the hash (Superseded 2026-11-10: the factory now has `set_guard_code` (S1) and `publish_guard_code_global`, O10/O11.) | `contracts/guard-factory/src/lib.rs:69-77,187`, `contracts/guard/src/lib.rs:693-718` |
| F8 | `migrate` reads the old layout as it is. Appending an enum variant keeps the old borsh bytes valid | `lib.rs:713-718` |
| F9 | The keeper signs `execute_plan_step` with 200 Tgas and reads events from the `send_tx` outcome (`EXECUTED_OPTIMISTIC`). `TxOutcome` has no `executor_id` | `apps/worker/src/keeper/near.ts:11-13,137-157,217-218` |
| F10 | `plan_steps.result_json` stores a whole `PlanStepResult`, which already has `amount_out` and `price`. `KdBudgetAlert.totals` has `received` and `avg_price` | `apps/worker/migrations/0002_keeper.sql:12-21`, `packages/key-doctor/src/types.ts:388-399,415` |
| F11 | `checkProposals` gives no owner-action alert for a proposal whose proposer is the Budget's Guard | `packages/key-doctor/src/proposals.ts:516` |
| F12 | The dashboard's Strategies grid marks everything except Scheduled payouts "Coming soon". The deep link `strategy=` opens the plan drawer for payouts only (Superseded 2026-11-10: the Strategies grid and the `strategy=` deep link open the DCA drawer (S4).) | `apps/dashboard/src/budget-view.ts:333-342,983`, `apps/dashboard/src/app.ts:482-487` |
| F13 | `strategies_list` lists `dca-near` as `coming_soon`. `setup_url` is given only for `live` (Superseded 2026-11-10: `dca-near` is `live` in `strategies_list` on testnet, `tools.ts:126`.) | `apps/guard-mcp/src/tools.ts:124-131,395` |

## 1. Slices (build order)

| # | Slice | Layers | Owner signs | Builder |
|---|---|---|---|---|
| S1 | Guard 1.3.0: `PlanAction::Swap` and the 4c step; factory `set_guard_code`; ADR 0007 | contract, ADR | no | backend-builder (contract), Lead writes ADR |
| S2 | Update the factory on testnet to hold Guard 1.3.0 | ops | yes (CLI, full-access key of the factory) | owner, with a script from S1 |
| S3 | Worker and library: swap result from Rhea logs, DCA texts, keeper gas | library, worker | no (deploy on merge) | backend-builder |
| S4a | Dashboard: DCA checklist actions Update Budget, Allow swaps, Enable USDT | dashboard | no (owner uses it in S5) | frontend-builder |
| S4b | Dashboard: DCA setup drawer, plan rows, USDT balance, card goes live on testnet | dashboard | no | frontend-builder |
| S5 | Live run: 2 sells on `payroll-2` with Telegram | ops | yes (wallet) | owner |
| S6 | `strategies_list` live for `dca-near`, README, backlog, §13.8 | guard-mcp, docs | no | backend-builder + Lead |

Contract files belong to S1 only. `packages/key-doctor/src/{types,messages,budget-alerts}.ts` belong to S3 only. S4a and S4b both touch `budget-view.ts`, `budget-flow.ts` and `app.ts`, so they run in order, never in parallel. S3 can run in parallel with S4a.

The first end-to-end run is S5. S1 starts with a sandbox chain that uses the real testnet wasm (D4). That chain is the tracer bullet for the risky part: gas, the registrations and the `min_amount_out` refusal.

## 2. S1: Guard contract

### Change 1.1: `contracts/guard/src/types.rs`: `PlanAction::Swap`
- **What:** append `Swap { pool_id: u64, token_out: AccountId, max_slippage_bps: u16 }` as the last variant. Fix the doc comment at line 109.
- **Why:** F1. The variant goes last so the existing state still decodes (F8). `migrate` does not change.
```rust
pub enum PlanAction {
    Transfer { receiver_id: AccountId },
    Call { /* unchanged */ },
    /// DCA (§11.11.3, 4c). Sells `amount_per_run` NEAR on the network's Rhea exchange; `min_amount_out` is set at run time.
    Swap { pool_id: u64, token_out: AccountId, max_slippage_bps: u16 },
}
```

### Change 1.2: `contracts/guard/src/policy.rs`: network constants and plan checks
- **What:** `dex_for(guard)` returns `(wrap, exchange)` from the Guard's own account suffix. It returns `Some(("wrap.testnet", "ref-finance-101.testnet"))` for `.testnet` and `None` otherwise (D9). `check_plan` refuses a swap with:
  - `SWAP_NOT_SUPPORTED` when `dex_for` gives none,
  - `INVALID_SLIPPAGE` unless `bps` is 50, 100 or 200 (`SWAP_SLIPPAGE_BPS`, `policy.rs:18`; superseded 2026-11-10: the plan's `1 <= bps <= 500` range was narrowed to these three),
  - `INVALID_TOKEN_OUT` when `token_out` is the wrap, the exchange, the Guard, the DAO or the factory.

  `plan_reasons` treats `Swap` like `Call` (no `NOT_WHITELISTED`). A swap still checks `max_per_tx` and `max_per_day`.
- **Why:** the Guard must know which contracts to call, and the keeper must not be able to pass them (K2). Per-plan ids would add fields and a check, with no gain: only the DAO creates plans, and the DAO can already call anything (ADR 0006 D3). A constant per network needs no state change.
```rust
pub fn dex_for(guard: &AccountId) -> Option<(&'static str, &'static str)> {
    guard.as_str().ends_with(".testnet").then_some(("wrap.testnet", "ref-finance-101.testnet"))
}
```

### Change 1.3: `contracts/guard/src/lib.rs`: step 4c
- **What:** in `execute_plan_step`, everything up to "slot moved and window counted" stays as it is (`lib.rs:372-402`). For `Swap`, store the `RequestRecord` (receiver = wrap, amount = `amount_per_run`), then call Rhea's `get_return` instead of `add_proposal`. The new `#[private] on_quote(request_id, plan_id)`:
  - On a failed view or a quote of `0`, it first calls `halt_plan(Failures, "QUOTE_FAILED")`, then `finish(Failed)`. That order keeps the code `QUOTE_FAILED`, because `finish` → `move_plan` would otherwise halt with `ADD_PROPOSAL_FAILED` (`lib.rs:793-795`). `finish` gives the window back (`lib.rs:824-835`).
  - On a good quote, it computes `min_out = quote × (10000 − bps) / 10000` in `u128`, builds the swap kind, and calls `add_proposal(...).then(on_proposal_added(request_id, Some(kind)))`.

  `on_proposal_added` gets an `Option<Value>` argument `kind`. It votes with that kind when the argument is set, and otherwise with `plan_kind`/`transfer_kind` as now (F3). A callback already in flight during an upgrade has no `kind`, which deserialises to `None`.
- **Why:** §11.11.3 4c. The quote is a cross-contract view, so it needs its own callback. The keeper still passes only `plan_id` (K2). `on_quote` is `#[private]`. The keeper gets no privilege (K1).
```rust
fn swap_kind(wrap: &str, exchange: &str, plan: &Plan, pool_id: u64, token_out: &AccountId, min_out: u128) -> Value {
    let msg = json!({ "actions": [{ "pool_id": pool_id, "token_in": wrap, "token_out": token_out,
        "amount_in": plan.amount_per_run, "min_amount_out": U128(min_out) }] }).to_string();
    json!({ "FunctionCall": { "receiver_id": wrap, "actions": [
        { "method_name": "near_deposit", "args": b64(json!({})), "deposit": plan.amount_per_run, "gas": U64(GAS_NEAR_DEPOSIT) },
        { "method_name": "ft_transfer_call", "args": b64(json!({ "receiver_id": exchange, "amount": plan.amount_per_run, "msg": msg })),
          "deposit": U128(1), "gas": U64(GAS_FT_TRANSFER_CALL) },
    ]}})
}
```
- **`move_plan` (`lib.rs:797-803`):** a failed vote on a `Swap` maps to `InsufficientBalance`, as `Transfer` does. The S4a checklist confirms the swap right before Start, so a failed vote means the Budget is short of NEAR.
- **Version:** `kd_guard_info` reports `1.3.0`.

### Change 1.4: gas (estimates; S1 measures them on the sandbox chain)

| Receipt | Own | Attaches | Static total |
|---|---|---|---|
| `act_proposal` (Sputnik) | ~15 | `near_deposit` 5 + `ft_transfer_call` F | 20 + F |
| `on_proposal_added` (swap) | ~5 | act 20 + F, `on_voted` 10 | 35 + F |
| `on_quote` | ~5 | `add_proposal` 20, `on_proposal_added` 35 + F | 60 + F |
| `execute_plan_step` | ~10 | `get_return` 10, `on_quote` 60 + F | 80 + F |

- Start with F = 150 Tgas. Rhea's own UI attaches 180 to a swap through `ft_transfer_call`. The keeper's 300 Tgas cap allows F up to about 200. Above that the step cannot fit, and the plan takes the cut path (D10).
- New constants: `GAS_QUOTE_VIEW`, `GAS_ON_QUOTE`, `GAS_ACT_PROPOSAL_SWAP`, `GAS_ON_ADDED_SWAP`, `GAS_NEAR_DEPOSIT`, `GAS_FT_TRANSFER_CALL`. Transfer and call plans keep today's numbers.
- Worst case left out: a pool that Rhea fails mid-swap. The vote still passes (F5) and the wNEAR comes back to the DAO through `ft_resolve_transfer`. That bounds the loss of a run at 0 NEAR, but the NEAR stays wrapped (D2).

### Change 1.5: what happens in each case (fixed in ADR 0007)

| Case | Guard state | Daily limit | Money |
|---|---|---|---|
| Over the 24 h limit | skip, `OVER_DAILY_LIMIT` (as today) | not counted | none moves |
| Quote fails or is 0 | paused `failures`, `QUOTE_FAILED` | given back | none moves |
| DAO short of NEAR | paused `insufficient_balance` (vote fails, F4) | given back | none moves |
| Swap refused at Rhea (`min_amount_out`) | run counted, request `Executed` (F5) | counted | `amount_per_run` stays in the DAO as wNEAR |
| Swap done | run counted | counted | USDT reaches the DAO |

The fourth row departs from §11.11.3 step 5 ("skip this run"): the Guard cannot see the Rhea outcome. The Worker reports it as a skip with the reason `SLIPPAGE` (S3). This is D2.

### Change 1.6: `docs/decisions/0007-dca-swap-step.md` (Lead) and the ADR index
Records these decisions and their alternatives:
- exchange ids come from the network constant, not per plan and not from Guard config,
- the quote runs inside the step with its own callback,
- the Guard cannot see SLIPPAGE; the Worker reads it from the transaction (row 4 above, D2),
- Enable USDT goes through DAO requests (D3),
- the factory gets a code setter and serves as the code source (D1).

### Change 1.7: `contracts/guard-factory/src/lib.rs`: `set_guard_code` (D1)
- **What:** `#[private] pub fn set_guard_code(#[serializer(borsh)] guard_code: Vec<u8>)`. It overwrites `GUARD_CODE_KEY`, `guard_code_hash` and `guard_code_len`, and emits `guard_code_set { code_hash, len }`. The `Factory` struct does not change, so a redeploy keeps the state with no `migrate`. Guards already created keep their code; new Guards get the new code.
- **Why:** owner decision D1. One account stays the registry and the code source: new Budgets start on 1.3.0, and existing Budgets upgrade with `code_source` = the factory. `#[private]` means only the factory account's own full-access key can change the code.
- **Tests:** `tests.rs`: another caller is refused; after the call `get_code_hash` and `get_guard_code` return the new code, and `create` deploys it.
```rust
#[private]
pub fn set_guard_code(&mut self, #[serializer(borsh)] guard_code: Vec<u8>) {
    self.guard_code_hash = env::sha256_array(&guard_code);
    self.guard_code_len = guard_code.len() as u64;
    env::storage_write(GUARD_CODE_KEY, &guard_code);
    emit("guard_code_set", json!({ "code_hash": Base58CryptoHash::from(self.guard_code_hash), "len": self.guard_code_len }));
}
```

### Change 1.8: `scripts/guard-setup/factory-update.sh` (new, used by the owner in S2)
Builds the Guard and factory wasm and prints the Guard's sha256 in base58. Then it redeploys the factory wasm on the factory account and calls `set_guard_code` with the Guard wasm (borsh args), both signed with the factory's full-access key. It tops up the factory first if the bigger code needs more storage. Last, it reads `get_code_hash` back and compares it with the local hash. It is a dry run unless `--send` is passed.

## 3. S2: rollout to testnet (owner)

1. `git pull` on `main` after S1 merges. Build both wasm with `cargo near build non-reproducible-wasm --no-abi` in `contracts/guard` and `contracts/guard-factory`.
2. `scripts/guard-setup/factory-update.sh keydoctor-guards-v2.testnet --send`. The owner signs with the factory's full-access key in the CLI. Cost: only the storage the bigger code adds. Record the new hash in the backlog and the README.
3. Nothing else changes: the dashboard (`KD_BUDGET_FACTORY`) and the keeper (`KEEPER_FACTORY_ID`) keep reading `keydoctor-guards-v2.testnet`. New Budgets start on 1.3.0. Existing Budgets take the S4a "Update your Budget" step, with the factory as `code_source` (D1).

## 4. S3: Worker and library

### Change 3.1: `apps/worker/src/keeper/near.ts`
- **What:**
  - Raise `KEEPER_GAS.execute_plan_step` to 300 Tgas. Unused gas is refunded.
  - Add `executor_id` and `status` to the `receipts_outcome[].outcome` type.
  - New `swapOutcome(tx, exchange, wrap, tokenOut)`. It reads only receipts whose `executor_id === exchange`. A log `Swapped <in> wrap.testnet for <out> usdt.fakes.testnet` gives `{ ok: amount_out }`. A failed exchange receipt gives `{ failed: code }` (`E68` slippage → `SLIPPAGE`, anything else → `SWAP_FAILED`). No exchange receipt gives `null`.
- **Why:** §11.11.3 says "amount bought comes from Rhea's log". Without the `executor_id` filter, any contract in the chain could log a fake `Swapped` line.
```ts
export function swapOutcome(tx: TxOutcome, exchange: string, wrap: string, tokenOut: string): { amount_out: string } | { failed: string } | null {
  const re = new RegExp(`^Swapped (\\d+) ${esc(wrap)} for (\\d+) ${esc(tokenOut)}$`);
  for (const r of tx.receipts_outcome) {
    if (r.outcome.executor_id !== exchange) continue;
    if (r.outcome.status.Failure) return { failed: /E68|SLIPPAGE/.test(JSON.stringify(r.outcome.status.Failure)) ? "SLIPPAGE" : "SWAP_FAILED" };
    for (const l of r.outcome.logs) { const m = re.exec(l); if (m) return { amount_out: m[2] }; }
  }
  return null;
}
```

### Change 3.2: `apps/worker/src/jobs/keeper.ts:189-198` (`stepRecord`)
- **What:** for a swap plan with `plan_step_executed`, attach `amount_out` and `price` from `swapOutcome`. `{ failed }` turns the record into `status: "skipped"` with that reason. `null` keeps `executed` with no `amount_out`: `send_tx` returned before the Rhea receipt ran (see the risk below). Exchange ids come from one shared constant in `packages/key-doctor` (`DCA_TESTNET`: wrap, exchange, pool 57, `usdt.fakes.testnet`, 6 decimals), which S4b also uses.
- **D1 row:** no schema change. `result_json` already holds `amount_out` and `price` (F10).
- **Request count:** no new subrequest. The data comes from the same `send_tx` outcome (`keeper.ts:167`).
- **Risk:** the swap chain is about 10 blocks, so `send_tx` with `EXECUTED_OPTIMISTIC` can time out. Then `send` throws (`keeper.ts:168-172`), no step row is saved, and the message has no USDT figure. The current code has the same gap for every plan. Measure it on the S5 run. A timeout there is a must-fix in S3: re-read the transaction by hash with the `tx` method, which adds 1 subrequest per swap step.

### Change 3.3: `packages/key-doctor/src/messages.ts:475-505` and `budget-alerts.ts:56-110`
- **What:**
  - `stepDone` gets a swap branch, using the §9.5 template.
  - `budgetAlerts` fills `totals.received` and `totals.avg_price` for a swap plan. It sums `amount_out` over the plan's saved `executed` steps and divides by those steps' `amount_in`, in bigint with 6 decimals.
  - A request whose saved step for the same `due` is `skipped` no longer also yields a `plan_step_executed`. Without that rule, a refused swap would send two messages.
  - `planSkippedText` gets a `SLIPPAGE` text that says the NEAR stays in the Budget as wrapped NEAR.
- **Why:** UC18 promises one message per run, with real numbers from the chain.
- **Text (vi + en, fixed templates):**
```
Key Doctor · DCA NEAR → USDT (1/2)
Đã bán 0.1 NEAR lấy 0.8965 USDT · giá 8.965        | Sold 0.1 NEAR for 0.8965 USDT · price 8.965
Giá bán trung bình: 8.965 · Đã nhận tổng: 0.8965 USDT | Average price: 8.965 · Received in total: 0.8965 USDT
Lần tới: 2026-11-13 09:15 UTC                         | Next run: 2026-11-13 09:15 UTC
Skip: Bỏ qua lần này: giá trượt quá mức bạn cho phép. 0.1 NEAR vẫn ở trong Budget (dạng wrapped NEAR).
      Skipped this run: the price moved more than you allow. 0.1 NEAR stays in your Budget as wrapped NEAR.
```
  - Without `amount_out`, the message has "Sold 0.1 NEAR for USDT" and no figure. It never shows a number from the quote.
  - The §9.5 line "NEAR balance left" is dropped (D8).

## 5. S4a: dashboard, the DCA checklist actions

### Change 4a.1: `apps/dashboard/src/budget-read.ts` / `guard-read.ts`: DCA readiness read
- **What:** `readDcaReadiness(dao, guard)` runs 5 views, all on one block, only when the DCA drawer opens:
  - `kd_guard_info` (version ≥ 1.3.0),
  - `get_code_hash` on the factory (the hash Update your Budget will vote on),
  - `storage_balance_of(dao)` on wrap, the exchange and USDT (3 views).

  The swap right comes from the policy the page already reads: the `agent-guard` role holds `call:AddProposal` and `call:VoteApprove`. Each item is `true`, `false` or `null` (unknown). An unknown item blocks only the final Start.

### Change 4a.2: `apps/dashboard/src/guard-proposals.ts`: two proposal builders
- **What:**
  - `upgradeGuardProposal(guardId, codeHash)` is `guardChangeProposal(guardId, "upgrade", { code_source: factory, code_hash })`, with the hash read from the factory in 4a.1. Shown only when `kd_guard_info` is below 1.3.0. It goes through the existing two-signature flow. After sign 2 the page reads `kd_guard_info` back, because a failed upgrade still shows Approved (ADR 0006).
  - `allowSwapsProposal(policy, guardId)` returns the whole policy (as in `addGuardRoleProposal`, `guard-proposals.ts:60-73`) with `call:AddProposal`, `call:VoteApprove` and `vote_policy.call` threshold 1 added to the role. It returns null when the role already has them.
  - `BUDGET_GUARD_PERMISSIONS` (four rights, §11.10.3) is used by Budget creation (`budget-create.ts:116`). `GUARD_PERMISSIONS` stays transfer-only for the Guard on an existing DAO (`app.ts:1906`). A new Budget starts on 1.3.0 with these rights, so it needs only Enable USDT.

### Change 4a.3: `apps/dashboard/src/guard-proposals.ts` + `wallet.ts`: Enable USDT through the DAO (D3)
- **What:** `enableUsdtProposals(dao, missing)` builds one `FunctionCall` request per contract still missing (wrap, exchange, USDT). Each is `storage_deposit({ account_id: dao, registration_only: true })` with the exact `storage_balance_bounds.min` as deposit, paid by the DAO. Signature 1 sends all `add_proposal` calls in one `signAndSendTransactions`; signature 2 sends all the approve votes in one batch. The checklist reads the registrations back after signature 2, because a failed call still shows Approved (ADR 0006). A partial state shows only the missing ones next time.
- **Why:** owner decision D3: the Budget is a DAO, so whatever it needs goes through a council vote. A Sputnik `FunctionCall` has one receiver, so §11.10.5's "one request on three contracts" becomes up to 3 requests, still 2 signatures.

### Change 4a.4: checklist order in the drawer (§11.11.4)
Connect wallet → Create Agent Budget → **Update your Budget** (2) → **Allow swaps** (2) → **Enable USDT** (2) → Top up `<short>` → Lower amount per run / Edit rules → Top up Budget account → **Start** (2). Each step keeps the form values. The button text says "Budget", not Guard, DAO or policy. The code source, hash and contract ids go only under Technical details.

## 6. S4b: dashboard, DCA setup and plan page

### Change 4b.1: `apps/dashboard/src/budget-flow.ts`: `dcaFromForm`, `createDcaProposal`
- **What:** the fields, from `docs/usecase.md` UC17:
  - NEAR per run,
  - how often (minutes, hours, days, weeks; reuses `PLAN_UNITS` plus weeks, minimum 1 minute as `MIN_PLAN_INTERVAL_SEC`),
  - stop after: N times (1–`MAX_PLAN_RUNS`) or an end date (D7). The Guard stores runs only, so the form turns an end date into `runs_total = floor((end − start) / interval) + 1` and refuses a date that gives 0 runs or more than `MAX_PLAN_RUNS`. The confirm step shows both the number of runs and the last run's date. No contract change,
  - max price drop 0.5 / 1 / 2 % (default 1 %),
  - start.

  It refuses what `check_plan` and `plan_limit_failure` refuse: `max_per_tx`, `max_per_day`, slippage outside the 3 choices. The proposal holds `action: { type: "swap", pool_id: 57, token_out: "usdt.fakes.testnet", max_slippage_bps }` and `strategy_id: "dca-near"`. `planTotals` is reused.
- **Why:** Sputnik shows a `create_plan` the Guard refused as Approved (`budget-flow.ts:227-231`), so the form must refuse first.

### Change 4b.2: `apps/dashboard/src/budget-view.ts`
- **What:**
  - `dcaPanel`: an edit step and a confirm step, like `planPanel` (`budget-view.ts:573-634`), with the checklist from 4a.4 above the form.
  - The confirm step shows: total NEAR, the shared 24 h limit left for agents, the schedule, "Key Doctor fee: free during testing", and "Prices can change. This is not investment advice."
  - One `get_return` view for one run gives "Right now 0.1 NEAR gets about 0.8965 USDT (testnet price)". That is one view per open.
  - `planRow` (`budget-view.ts:364-371`) shows a swap plan as "Sell 0.1 NEAR for USDT every 1 day".
  - `payoutsCard` becomes a "Plans" card with New payout and New DCA.
  - The balance card adds "USDT in your Budget" from `ft_balance_of(usdt, dao)` (D6).
  - The `STRATEGIES` pill reads "After setup" for DCA on testnet (`budget-view.ts:342,983`). Other cards stay Coming soon.
- `apps/dashboard/src/app.ts:482-487`: `strategy=dca-near` opens the DCA drawer.
- **Words:** no DAO, proposal, policy, whitelist, yocto or nonce in visible text outside Technical details.

## 7. S5: live run (owner, wallet)

1. Merge S3 (the Worker deploys on merge) and S4a/S4b (Pages deploy on merge).
2. On `payroll-2`: Update your Budget (2 signatures) → Allow swaps (2) → Enable USDT (2) → New DCA: 0.1 NEAR, every 15 minutes, 2 times, 1 % → Start (2). That is 8 signatures.
3. The keeper (cron `7,22,37,52`) runs 2 steps. Check the DAO's USDT balance over RPC, the two Telegram messages (Sold … for … USDT) and the `plan_steps` rows. Record the tx hashes, the gas burnt per step and whether `send_tx` returned the Rhea receipt (S3 risk).
4. Fill in the open items of B-Q4: registration and gas.

**Result (run 2026-11-09, recorded 2026-11-10 from RPC and NearBlocks):** all four checklist steps went through on `payroll-2` (proposals 12–17). Plan 2 ran at 300 s, not 15 minutes. Two sells: 0.1 NEAR → 0.896491 USDT (proposal 18, 16:37 UTC) and 0.1 NEAR → 0.787603 USDT (proposal 19, 17:07 UTC), then `plan_completed`. Gas per sell is 39.3 / 39.4 Tgas on testnet (sandbox: 37.6) and the largest receipt is 6.7 Tgas, with 0 failed receipts. Tx hashes are in `docs/stories/backlog.md` O9. Registration stays open: the DAO is registered on all three contracts, so the run does not show whether the exchange registration is needed. Telegram (owner, 2026-11-10): the 2/2 message names 0.787603 USDT, an average price of 8.42047 and 1.684094 USDT in total, all matching the chain, so `send_tx` returned the Rhea receipt and the S3 risk did not happen. Not checked: `plan_steps` (remote D1 is unreadable from here).

## 8. S6: guard-mcp and docs

- `apps/guard-mcp/src/tools.ts:124-131`: `dca-near` becomes `live`. `setup_url` follows the same rule as payouts (`tools.ts:395`). The `plans_status` row text gets a swap branch (`PlanView.action`, `tools.ts:105`). The `strategies_list` description no longer calls DCA coming soon.
- README (feature plus Limitations: testnet pool price, wrapped NEAR after a refused swap, no USDT Withdraw yet), `docs/stories/backlog.md` C12, `docs/final-idea.md` §13.8 row 31 and §16 B-Q4.

## 9. Decisions

| # | Decision | Options | Lead recommendation |
|---|---|---|---|
| D1 | How Guard 1.3.0 reaches Budgets | (a) new code-source account. (b) factory `set_guard_code`, redeploy `keydoctor-guards-v2.testnet` | **Owner: (b)** (2026-11-09). New Budgets start on 1.3.0; existing ones upgrade from the factory. The README's v2 hash line changes |
| D2 | A swap refused at Rhea | The Worker follows the step's transaction, reads the Rhea receipt and reports `SLIPPAGE` in Telegram and the step history. On chain the Guard still counts the run (F5): `ft_transfer_call` succeeds because Rhea refunds | **Owner: accept** (2026-11-09). Documented in ADR 0007 and README Limitations. The plan ends with one sell fewer; the NEAR stays as wNEAR |
| D3 | Enable USDT | (a) owner's wallet pays. (b) DAO requests | **Owner: (b)** (2026-11-09): the Budget is a DAO, so it votes. Up to 3 requests, 2 signatures (4a.3) |
| D4 | Proof of gas and registration before the live run | (a) sandbox chain with the testnet wasm of `wrap.testnet`, `ref-finance-101.testnet`, `usdt.fakes.testnet` (from `view_code`), pool seeded locally. (b) live only | **(a), timeboxed to half a day**. If it overruns, (b) on `payroll-2`, accepting that a failing step costs a fix-and-upgrade round |
| D5 | Swap right on the Guard role | `Allow swaps` request for existing Budgets plus four rights at Budget creation (§11.10.3) | **Both**. The Guard can call only what a DAO-made plan holds, and the keeper still passes only `plan_id` |
| D6 | "USDT received" on the plan page | (a) the DAO's USDT balance from the chain. (b) per-plan received from D1, which needs a new Worker API | **(a)**. Per-run numbers are in Telegram |
| D7 | "Runs or end date" field | runs only, or both | **Owner: both** (2026-11-09). The form turns an end date into runs; no contract change |
| D8 | "NEAR balance left" line in the step message | +1 view per message, or drop it | **Drop** for GĐ31 |
| D9 | Mainnet | `dex_for` gives none off testnet, so `create_plan` refuses a swap there | **Yes**, testnet only per CLAUDE.md |
| D10 | Deadline 2026-11-14 23:59 UTC and cut | Timebox: S1 with the sandbox chain green by 11-11 EOD, S5 done by 11-13. Cut trigger: F over ~200 Tgas, or S1 not green by 11-11 | **Cut to §11.11.1 "full config screen + Coming soon button"**: ship S4b with Start replaced by Coming soon, no S2/S5, and keep S1 unmerged. GĐ31 is first in the cut order (§13.8) |
| D11 | Withdraw USDT (§11.11.3 says the owner withdraws USDT with Withdraw) | build now, or Roadmap | **Roadmap + README Limitation**. The USDT stays safe in the DAO |
