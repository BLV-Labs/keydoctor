# Key Doctor On Call

Key Doctor checks the access keys of a NEAR account or a Sputnik DAO council, and stays on call: it alerts the council on Telegram when a voter on a pending proposal has a freshly added full-access key.

Built for the NEAR HACKATHON (1–14 Nov 2026). The design is in `docs/final-idea.md` (Vietnamese).

## Status

- GĐ0 done: the monorepo, the data contracts (`packages/key-doctor/src/types.ts`) and sample fixtures.
- GĐ1 done: the scan library (`scanAccount`, `scanDao`, the key rules), checked against live testnet RPC.
- GĐ7 built: the dashboard (`apps/dashboard`) with the check form, the council report, the account profile and the Telegram alerts dialog. Not deployed to Pages yet.
- Not built yet: the bot, the MCP server, proposal watching, and the key cleanup plan (GĐ8).

## Try it

Requires Node.js 22.18 or newer.

```bash
npm install
npm test          # fixture contract checks
npm run typecheck # library source is checked without Node types (fetch only)
```

Run the dashboard locally:

```bash
npm run dev -w dashboard   # http://localhost:8788
```

Open `http://localhost:8788/?target=<account or DAO>`, for example a `.testnet` account. Key Doctor scans it in your browser through public NEAR RPC. A Sputnik DAO shows its council report. Any other account shows its key profile. `npm run build -w dashboard` writes the static site to `apps/dashboard/dist/`.

## License

MIT, see `LICENSE`.
