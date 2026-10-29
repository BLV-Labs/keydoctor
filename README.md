# Key Doctor On Call

Key Doctor checks the access keys of a NEAR account or a Sputnik DAO council, and stays on call: it alerts the council on Telegram when a voter on a pending proposal has a freshly added full-access key.

Built for the NEAR HACKATHON (1–14 Nov 2026). The design is in `docs/final-idea.md` (Vietnamese).

## Status

Phase GĐ0 of 15 is done: the monorepo, the data contracts (`packages/key-doctor/src/types.ts`) and sample fixtures. The scanner, bot, MCP server and dashboard are not built yet.

## Try it

Requires Node.js 22.18 or newer.

```bash
npm install
npm test          # fixture contract checks
npm run typecheck # library source is checked without Node types (fetch only)
```

## License

MIT, see `LICENSE`.
