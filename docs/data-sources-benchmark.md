# Data sources: NEAR RPC vs the NearBlocks API

Question: scans feel slow over NEAR RPC. Can the NearBlocks indexer API replace RPC, and what do speed and rate limits look like for each source?

Short answer: **NearBlocks cannot replace RPC for Key Doctor.** It cannot call contract view methods (`get_policy`, `get_proposal`) or pin reads to one block. On its free tier (6 calls per minute) it is also slower than RPC for any DAO scan. The slowness most likely comes from the deprecated `rpc.*.near.org` endpoints, which are heavily rate-limited, not from RPC itself. The next step is to measure the endpoints side by side with `pnpm bench` (below), and then pick a faster RPC provider if the numbers support it.

> **Status: measurements pending.** The tables under [Results](#results) are empty on purpose. The build container's network policy blocks `rpc.*.near.org`, `*.fastnear.com` and `*.nearblocks.io`, so the benchmark has not run yet. Nothing below is a measured number unless the Results section says so.

## What one scan asks for

Every count comes from `packages/key-doctor/src/scan.ts` and `proposals.ts`. Each request is one HTTP call to RPC.

| Operation | RPC calls | RPC method |
|---|---|---|
| Account scan | 2, plus 1 if the key list is empty, plus 1 per distinct function-call receiver (receiver check) | `block`, `view_access_key_list`, `view_account` |
| DAO scan, M council members | 2 + M (+ M more for members with no keys), plus receiver checks, within `REQUEST_BUDGET` = 45 | `block`, `call_function get_policy`, `view_access_key_list` per member, `view_account` |
| Proposal watch, per DAO per run | 3 + up to 12 `get_proposal` + up to 8 voter key scans | `block`, `call_function get_last_proposal_id` / `get_policy` / `get_proposal` |

The scan runs up to 4 calls at once (`CONCURRENCY_DEFAULT`). A 10-member DAO with a few app keys therefore costs about 15–25 calls. **Rate limit per minute decides the speed more than latency per call does.**

## What NearBlocks can and cannot answer

| Need | NEAR RPC | NearBlocks API |
|---|---|---|
| Access key list of an account | `view_access_key_list` | `GET /v1/account/{id}/keys` (from the indexer) |
| When a key was added | Estimated from the nonce (`floor(nonce / 10^6)` → block → time, about ±1 day) | Likely the exact creation transaction and time (indexer data; the benchmark records the field names to confirm) |
| Account exists / balance | `view_account` | `GET /v1/account/{id}` |
| DAO policy (council, roles, thresholds) | `call_function get_policy` | **No.** The API does not run contract view methods. |
| Proposals and votes | `call_function get_last_proposal_id`, `get_proposal` | **No.** Same reason. |
| Every read at one `block_height` | Yes (`block_id`) | **No.** Answers come from the indexer's current state. |
| Freshness | Final block | Indexer lag (usually seconds, more during incidents) |
| Runs in the browser | Yes (CORS open) | Needs a check; with an API key the key would sit in the static site, so the dashboard could not use a paid key |

Key Doctor's rules need three things NearBlocks lacks: `get_policy` for every DAO scan, `get_proposal` for the proposal watch (the main demo scene), and one `block_height` for the whole scan (an invariant in `CLAUDE.md`). So NearBlocks can only ever be an **extra** source, for example to show the exact time a key was added. It cannot be the main one.

## Rate limits as published

These come from public pages, not from measurement. The [Results](#results) section shows what the endpoints actually did when the benchmark ran. Check the provider pages before relying on these numbers, because they change.

| Source | Free limit (published) | Notes |
|---|---|---|
| `rpc.mainnet.near.org` / `rpc.testnet.near.org` | Deprecated by NEAR and "heavily rate-limited". The phase-1 notice (June 2025) gave mainnet 120 requests/minute and 600 per 10 minutes per IP; later snapshots list far lower limits. | NEAR's docs tell production apps to use another provider. |
| FastNEAR (`rpc.mainnet.fastnear.com`, `free.rpc.fastnear.com`) | Free endpoint with higher limits than near.org; an optional API key raises them. | Same JSON-RPC, so the library would only need a new `rpcUrl`. |
| NearBlocks API, free plan | 6 calls/minute, 333 calls/day, 10,000 calls/month; attribution required, personal use | The testnet pricing page lists the monthly cap. |
| NearBlocks API, Startup plan | 190 calls/minute, about $67/month | Enterprise: custom. |

What this means on the free tier:

- **NearBlocks free:** a 10-member DAO needs at least 11 key reads, which takes about 2 minutes at 6 calls/minute. It still needs RPC for `get_policy`. The proposal job (every 15 minutes, up to 5 DAOs) would use up 333 calls a day within hours. So NearBlocks free is too slow and too small.
- **NearBlocks Startup:** 190/minute is enough for speed. It would cost money, still leave contract calls on RPC, and drop block pinning.
- **Another RPC provider:** this keeps every invariant and needs no code change beyond the URL. It is the cheapest fix, if the benchmark shows it is faster.

## How to run the benchmark

From the repo root, on a machine that can reach the endpoints:

```bash
pnpm bench --account <your-account>.testnet --dao verdict-panel-p8n6.sputnik-v2.testnet --runs 5
```

```bash
NEARBLOCKS_API_KEY=<key> pnpm bench --account <your-account>.near --dao <your-dao>.sputnik-dao.near --runs 5 --burst 30
```

- Each source gets `--runs` calls of each kind, with a pause between calls (300 ms for RPC; 10.5 s for NearBlocks without a key, to stay under 6 calls/minute).
- RPC sources default to `rpc.<network>.near.org` and `rpc.<network>.fastnear.com`. Add others with `--rpc <url>` (repeatable); only the host goes into the output.
- Each RPC also runs a full library scan (`scanTarget`, the call the dashboard and the bot make), so the table shows real scan time and not only single calls.
- `--burst N` sends N calls back to back to each source. It reports how many came back 429, when the first 429 came, and the rate-limit headers the server sent. It is off by default because it spends quota.
- The output goes to `data/bench-sources-<network>.json` and `.md`. It holds key and member counts only, never account names, so a mainnet run can be pasted here.

## Results

_Pending. Paste the Markdown that `pnpm bench` prints here, one block per network, with the date and the machine's location (latency depends on distance to the provider)._

## Decision (to take after the run)

1. If FastNEAR (or another provider) is clearly faster and rate-limits later than `near.org`: make it the default in `DEFAULT_RPC_URL` (`packages/key-doctor/src/rpc.ts`), add its host to the dashboard CSP `connect-src` (`apps/dashboard/public/_headers`), and let the Worker take an `RPC_URL` override.
2. Keep NearBlocks out of the scan path. Consider it later as an optional source that adds the exact time a key was added (Roadmap), only if the benchmark confirms the field exists.
