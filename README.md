# Key Doctor On Call

Key Doctor checks the access keys of a NEAR account or a Sputnik DAO council, and stays on call: it alerts the council on Telegram when a voter on a pending proposal has a freshly added full-access key.

Built for the NEAR HACKATHON (1–14 Nov 2026). The design is in `docs/final-idea.md` (Vietnamese).

## Status

- GĐ0 done: the pnpm workspaces monorepo, the data contracts (`packages/key-doctor/src/types.ts`) and sample fixtures.
- GĐ1 done: the scan library (`scanAccount`, `scanDao`, the key rules), checked against live testnet RPC.
- GĐ2 done: `diffReports` and `toSummary` (pure; compare two scans, drop key lists).
- GĐ5 built: `checkProposals` (proposal watch: governance, code-upgrade and new-key-voter alerts). Waiting on a live testnet check.
- GĐ7 built: the dashboard (`apps/dashboard`) with the check form, the council report, the account profile and the Telegram alerts dialog. Not deployed to Pages yet.
- Not built yet: the Worker (bot, MCP server, proposal-watch job) and the key cleanup plan (GĐ8).

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

## License

MIT, see `LICENSE`.
