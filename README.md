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
- Not built yet: the Telegram bot (GĐ4), the proposal-watch job (GĐ6), the daily key diff (GĐ9) and the key cleanup plan (GĐ8).

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

## License

MIT, see `LICENSE`.
