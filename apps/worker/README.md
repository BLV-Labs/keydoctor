# Worker operations: the keeper

The keeper (ADR 0005, GĐ29) calls Guard plan steps that are due, on testnet only. It pays gas and decides nothing: every check is in the Guard. Its code is in `src/jobs/keeper.ts` and `src/keeper/near.ts`.

It runs on testnet since 2026-11-06 as `keydoctor-keeper.testnet`, every 15 minutes. Two Budgets exist since 2026-11-08 (`payroll-1`, `payroll-2`), and on 2026-11-09 the keeper ran live on `payroll-2`: Scheduled payout plan 1 (0.1 NEAR × 3) and DCA plan 2 (2 sells) both ended `completed` (`docs/live-test-plan.md` K3, K4). Without the setup below it stays off and touches neither RPC nor D1.

It also tells a guardian's `pause` (GĐ28): `pause()` has no proposal for the proposal job to read, so the keeper sends one `budget_owner_action` per pause, on its own cycle. That code is deployed with the Worker since 2026-11-07; a pause has not been seen live yet.

## Jobs

`POST /run-check` with `{"job": "proposals" | "daily" | "keeper" | "yield", "target"?}` runs the same function as the cron. Crons (`wrangler.toml`): `proposals` `*/15 * * * *`, `daily` `0 2 * * *`, `keeper` `7,22,37,52 * * * *`, `yield` `11,26,41,56 * * * *`. The rest of this file is about the keeper.

## Turn it on (owner)

1. Create a testnet account for the keeper and fund it with `KEEPER_MAX_BALANCE` (5 NEAR) or less. Never add it to a DAO, a Guard whitelist or a plan: the job refuses such a Budget (K1).
2. Apply the migration: `pnpm --filter worker db:migrate:remote`.
3. Set `KEEPER_ACCOUNT_ID` in `wrangler.toml`.
4. `pnpm --filter worker exec wrangler secret put KEEPER_PRIVATE_KEY`, and paste the `ed25519:...` key at the prompt, so it stays out of the shell history. Do the same for `KEEPER_ALERT_CHAT_ID`, the chat that gets the balance warnings: the repo is public and a chat id is personal.
5. `pnpm --filter worker run deploy`.
6. Run one cycle by hand and read `errors`:

   ```bash
   curl -X POST "$WORKER_URL/run-check" -H "authorization: Bearer $RUN_CHECK_TOKEN" -d '{"job":"keeper"}'
   ```

## Rotate the key (K5)

The key is a full-access key of the keeper account, and only that account's balance is at risk. No Budget money is reachable with it (K1, K2).

1. Add a new full-access key to the keeper account with near-cli.
2. `pnpm --filter worker exec wrangler secret put KEEPER_PRIVATE_KEY` with the new key.
3. Run one cycle by hand as above. `errors` must be empty.
4. Delete the old key from the account.

If the key may have leaked, delete it first and rotate after. Steps wait for the next cycle in the meantime, and missed slots do not pile up: the Guard runs one step per call.

## How it behaves

- **Schedule:** cron `7,22,37,52 * * * *`, so a step runs up to 15 minutes late, or later with more than 3 Guards: each cycle reads 3 Guards in turn.
- **Limits per cycle:** 3 Guards, 3 step transactions, 2 syncs, 4 Telegram sends (`MAX_SENDS`). The busiest cycle stays within the 50 subrequests of the free plan, D1 included (`test/keeper.test.ts`). It can pass 50 only if the first RPC fails on every call, or if one Budget has more chats than the sends left in the cycle. A cycle cut short that way loses nothing: steps stay due, and unsent messages go out next time.
- **Overlap:** a D1 lease of 10 minutes keeps two cycles apart. A cycle that dies frees it by running out.
- **A failed send** stops all signing for that cycle, because the transaction may still land and the nonce is unknown. The next cycle reads the chain again.
- **Balance:** below `KEEPER_MIN_BALANCE` or above `KEEPER_MAX_BALANCE`, the alert chat gets one warning a day. The job keeps working above the maximum.

## Measured: CPU on the free plan (10 ms)

Local `workerd` 1.20261006.1 on an Apple Silicon Mac, 2026-11-06, with RPC and Telegram stubbed inside the Worker and local D1. Times are wall clock from outside the Worker, so they include D1 and are not production CPU.

| Work | New isolate (median) | Warm (median) |
|---|---|---|
| One Ed25519 signature | 0.38 ms | 0.02 ms |
| Cycle, nothing due | 5.4 ms | 2.9 ms |
| Cycle, one step | 5.9 ms | 3.2 ms |
| Busiest cycle (3 Guards, 3 steps, 2 syncs, 5 sends, 50 requests per Guard) | 10.5 ms | 6.6 ms |

Signing is not the cost. A normal cycle has room, and the busiest one sits at the limit on this machine. Read the real CPU time in the Cloudflare dashboard after the first live cycles. If a cycle is killed, nothing is lost for the reasons above, and lowering `KEEPER_MAX_GUARDS_PER_RUN` is the first fix.
