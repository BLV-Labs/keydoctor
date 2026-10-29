# Key Doctor On Call

Key Doctor checks the access keys of a NEAR account or a Sputnik DAO council, and stays on call: it alerts the council on Telegram when a voter on a pending proposal has a freshly added full-access key.

Built for the NEAR HACKATHON (1–14 Nov 2026). The design is in `docs/final-idea.md` (Vietnamese).

## Status

- GĐ0 done: the pnpm workspaces monorepo, the data contracts (`packages/key-doctor/src/types.ts`) and sample fixtures.
- GĐ1 done: the scan library (`scanAccount`, `scanDao`, the key rules), checked against live testnet RPC.
- GĐ2 done: `diffReports` and `toSummary` (pure; compare two scans, drop key lists).
- GĐ5 built: `checkProposals` (proposal watch: governance, code-upgrade and new-key-voter alerts). Waiting on a live testnet check.
- GĐ7 built: the dashboard (`apps/dashboard`) with the check form, the council report, the account profile and the Telegram alerts dialog. Not deployed to Pages yet.
- GĐ3 built: the Worker (`apps/worker`) with the MCP server (`diagnose`, `compare`) and D1 baselines. Not deployed yet.
- GĐ4 built: the Telegram bot (`/check`, `/changes`, `/watch`, `/unwatch`, `/list`, `/help`; plain messages with one `*.near` / `*.testnet` name run `/check`). Not deployed yet.
- GĐ6 built: the proposal-watch job (cron every 15 minutes, once per DAO, send first then record `alerts_sent`), `POST /run-check`, and `scripts/demo-testnet/demo.sh`. Waiting on a live testnet run.
- GĐ9 built: the daily key diff (cron at 02:00 UTC; it moves the baseline and alerts only on changes).
- GĐ10 built: `pnpm stats` measures the network-wide numbers and writes `data/network-stats.json` and `data/network-stats.md`. The numbers are not in this README until the owner runs it against live RPC.
- Not built yet: the key cleanup plan (GĐ8, waiting on the Meteor signing test).

## Try it

Requires Node.js 22.18 or newer and pnpm 10 (`corepack enable` installs the pinned version).

```bash
pnpm install
pnpm test        # library and dashboard tests
pnpm typecheck   # library source is checked without Node types (fetch only)
```

Run the dashboard locally:

```bash
pnpm --filter dashboard dev   # http://localhost:8788
```

Open `http://localhost:8788/?target=<account or DAO>`, for example a `.testnet` account. Key Doctor scans it in your browser through public NEAR RPC. A Sputnik DAO shows its council report. Any other account shows its key profile. `pnpm --filter dashboard build` writes the static site to `apps/dashboard/dist/`.

## MCP server (local)

The Worker serves MCP over Streamable HTTP at `POST /mcp` with `Authorization: Bearer <MCP_TOKEN>`. Tools:
- `diagnose {target, network?, detail?}` returns `kd.report_summary.v1`, or `kd.report.v1` with `detail: "full"`. It stores nothing.
- `compare {target, network?, update_baseline?}` returns `kd.diff.v1` against the stored baseline. The baseline moves only on the first call or with `update_baseline: true`.

Run it locally with a local D1:

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
pnpm --filter worker db:migrate:local
pnpm --filter worker dev   # http://localhost:8787
```

Call `diagnose`:

```bash
curl -s http://localhost:8787/mcp \
  -H 'authorization: Bearer change-me-mcp' -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"diagnose","arguments":{"target":"verdict-panel-p8n6.sputnik-v2.testnet"}}}'
```

Add it to Claude Code:

```bash
claude mcp add --transport http key-doctor http://localhost:8787/mcp --header "Authorization: Bearer change-me-mcp"
```

## Telegram bot (after deploy)

The bot runs in the same Worker at `POST /telegram`. Each update must carry the `X-Telegram-Bot-Api-Secret-Token` header. The Worker answers 200 at once and does the work in `ctx.waitUntil`. Replies are plain text in Vietnamese or English, based on the user's Telegram language. After `wrangler secret put TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`, register the webhook:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d url=https://<your-worker>.workers.dev/telegram \
  -d secret_token=$TELEGRAM_WEBHOOK_SECRET -d 'allowed_updates=["message"]'
```

Then send `/check kd-demo.sputnik-v2.testnet` (or any testnet DAO) to the bot.

## Testnet demo (after deploy)

`scripts/demo-testnet/demo.sh` builds a 3-member DAO that needs 2 votes, then plays the attack one step at a time with near-cli-rs and your own testnet keys. The header of the script lists the steps and the 48-hour timing note.

```bash
export KD_DEMO_PREFIX=kdd$(date +%s) KD_WORKER_URL=https://<your-worker>.workers.dev RUN_CHECK_TOKEN=<token>
scripts/demo-testnet/demo.sh accounts && scripts/demo-testnet/demo.sh dao
# Telegram: add the bot to a group, send /watch <dao printed above>
scripts/demo-testnet/demo.sh transfer && scripts/demo-testnet/demo.sh compromise && scripts/demo-testnet/demo.sh vote
scripts/demo-testnet/demo.sh run-check   # the group gets the alert that names the members who have not voted
```

`POST /run-check` with `{"job": "proposals" | "daily", "target"?}` runs the same function as the cron and returns `{job, targets_checked, alerts_sent, alerts, errors}`.

## Network stats (reproducible)

```bash
pnpm stats                      # mainnet Sputnik DAOs, pinned to the latest final block
pnpm stats -- --block <height> --rpc https://archival-rpc.mainnet.near.org   # rerun at a fixed block
```

The script lists every DAO from the factory and keeps the ones with a proposal in the last 365 days (`--active-days`). It scans their councils with the same library, all at one block, and prints the Markdown table. It writes `data/network-stats.json` (`kd.network_stats.v1`) and `data/network-stats.md`. Only aggregates are written: no DAO or account names. Raw RPC answers are cached under `data/raw/` (gitignored), so a rerun at the same block is offline.

## License

MIT, see `LICENSE`.
