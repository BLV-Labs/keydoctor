# Data sources: NEAR RPC vs the NearBlocks API

Question: scans feel slow over NEAR RPC. Can the NearBlocks indexer API replace RPC, and what do speed and rate limits look like for each source?

Short answer: **NearBlocks cannot replace RPC for Key Doctor.** It cannot call contract view methods (`get_policy`, `get_proposal`) or pin reads to one block. On its free tier (6 calls per minute) it is also slower than RPC for any DAO scan. The slowness came from the deprecated `rpc.*.near.org` endpoint, not from RPC itself. On testnet it answered every call in about 3.3 s. FastNEAR answered the same calls in about 0.28 s, so a full DAO scan took 0.9 s instead of 10.2 s (11× faster). On mainnet the gap is wider: about 3.1 s vs 0.09 s per call. **Key Doctor now defaults to FastNEAR, and fails over to near.org on rate limits** (see [Decision](#decision)).

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

### Testnet, 2026-10-29

Run by the team from their own machine; raw output in [`data/bench-sources-testnet.md`](../data/bench-sources-testnet.md) and `.json`. 5 runs per call, account with 1 key, DAO with 2 council members, NearBlocks free tier (no API key), no `--burst`.

| Source | Call | OK | p50 ms | p95 ms | min–max ms |
|---|---|---|---|---|---|
| rpc.testnet.near.org | block (final) | 5/5 | 3278 | 3921 | 3260–3921 |
| rpc.testnet.near.org | view_access_key_list | 5/5 | 3328 | 4024 | 3250–4024 |
| rpc.testnet.near.org | view_account | 5/5 | 3287 | 3350 | 3254–3350 |
| rpc.testnet.near.org | call_function get_policy | 5/5 | 3313 | 3785 | 3250–3785 |
| rpc.testnet.near.org | call_function get_last_proposal_id | 5/5 | 3268 | 3369 | 3251–3369 |
| rpc.testnet.near.org | **full scan (2 members)** | 5/5 | **10161** | 10262 | 9871–10262 |
| rpc.testnet.fastnear.com | block (final) | 5/5 | 282 | 315 | 262–315 |
| rpc.testnet.fastnear.com | view_access_key_list | 5/5 | 294 | 356 | 287–356 |
| rpc.testnet.fastnear.com | view_account | 5/5 | 278 | 376 | 263–376 |
| rpc.testnet.fastnear.com | call_function get_policy | 5/5 | 294 | 304 | 267–304 |
| rpc.testnet.fastnear.com | call_function get_last_proposal_id | 5/5 | 278 | 377 | 254–377 |
| rpc.testnet.fastnear.com | **full scan (2 members)** | 5/5 | **893** | 918 | 823–918 |
| NearBlocks API (api-testnet) | GET /v1/account/{id} | 5/5 | 1225 | 1316 | 393–1316 |
| NearBlocks API (api-testnet) | GET /v1/account/{id}/keys | 5/5 | 481 | 1174 | 380–1174 |

What the numbers say:

- **`rpc.testnet.near.org` adds about 3 s to every call**, even to `block`, the cheapest one. Its minimum (3250 ms) sits close to its median, so this looks like a fixed throttle delay rather than network distance. Each scan step waits on the one before it (block, then policy, then the member keys), so these delays add up: 10 s for a 2-member DAO, and more for a bigger council.
- **FastNEAR is about 12× faster per call and 11× faster per full scan.** No call failed, and none was rate-limited, during this run.
- **NearBlocks** answered in 0.4–1.3 s per call: faster than `near.org`, slower than FastNEAR, and still limited to 6 calls per minute on the free tier. The script did not find a key list in the `/keys` answer (`nearblocks_key_fields` is null), so the "exact time a key was added" field is **not confirmed**.
- Not measured on testnet: larger councils and the burst limit (`--burst`) of each source.

### Mainnet, 2026-10-30

Run by the team from the same machine; raw output in [`data/bench-sources-mainnet.md`](../data/bench-sources-mainnet.md). 5 runs per call, one account with 32 keys (no DAO, so no `get_policy` rows), NearBlocks free tier, no `--burst`. Each source ran alone; the default failover list did not exist yet.

| Source | Call | OK | p50 ms | p95 ms | min–max ms | Errors |
|---|---|---|---|---|---|---|
| rpc.mainnet.near.org | block (final) | 5/5 | 3137 | 3157 | 3090–3157 | – |
| rpc.mainnet.near.org | view_access_key_list | 5/5 | 3099 | 3157 | 3092–3157 | – |
| rpc.mainnet.near.org | view_account | 5/5 | 3089 | 3127 | 3082–3127 | – |
| rpc.mainnet.near.org | **full scan (32 keys)** | **2/5** | 12633 | 28074 | 12633–28074 | 3× 429 |
| rpc.mainnet.fastnear.com | block (final) | 5/5 | 88 | 260 | 86–260 | – |
| rpc.mainnet.fastnear.com | view_access_key_list | 5/5 | 87 | 115 | 80–115 | – |
| rpc.mainnet.fastnear.com | view_account | 5/5 | 86 | 155 | 78–155 | – |
| rpc.mainnet.fastnear.com | **full scan (32 keys)** | **4/5** | 843 | 935 | 825–935 | 1× 429 |
| NearBlocks API | GET /v1/account/{id} | 5/5 | 425 | 1171 | 388–1171 | – |
| NearBlocks API | GET /v1/account/{id}/keys | 5/5 | 507 | 1241 | 413–1241 | – |

What the numbers say:

- **`rpc.mainnet.near.org` has the same ~3.1 s floor per call as testnet**, and it rate-limited 3 of 5 full scans. On its own it is not usable for a dashboard.
- **FastNEAR on mainnet answers in under 0.1 s (p50 87 ms), about 35× faster per call.** A full scan of a 32-key account took 0.84 s.
- **FastNEAR also rate-limits a heavy scan.** A 32-key account means one `view_account` per distinct app-key receiver (up to `REQUEST_BUDGET`), sent 4 at a time, and 1 of 5 scans hit a 429. That is why the library now fails over to `near.org` and, if every endpoint is limited, waits once and tries again (Decision 2).
- **NearBlocks `/keys` does return `created` and `deleted`** for each key (fields: `account_id`, `created`, `deleted`, `permission_kind`, `public_key`). So the indexer can give the exact time a key was added, instead of Key Doctor's nonce-based estimate. Calls took 0.4–1.2 s, still capped at 6 per minute on the free tier.

## Decision

1. **Done:** FastNEAR is now the default RPC, with `near.org` as the fallback. That covers `DEFAULT_RPC_URLS` in `packages/key-doctor/src/rpc.ts` (library, dashboard and scripts), `RPC_URL_TESTNET` / `RPC_URL_MAINNET` in `apps/worker/wrangler.toml` (a comma-separated list, which the Worker can still override), and the dashboard CSP `connect-src` (both providers). Both networks are now benchmarked (above).
2. **Done: failover between endpoints.** `rpcUrl` (and `RPC_URL_*` in the Worker) accepts a list. Each call tries the endpoints in order, starting with the one that answered last. It moves on only after a transport failure: 429, any other non-2xx, a timeout, a network error, an unreadable body, or `UNKNOWN_BLOCK` from a node that lags behind. A JSON-RPC answer such as `UNKNOWN_ACCOUNT` or a contract error is final, because another node would say the same. Every query keeps its `block_id`, so a switch mid-scan does not change what the scan reads. When every endpoint answers 429, the call waits `RATE_LIMIT_BACKOFF_MS` (1 s) once and tries them all again. Only after that does the scan fail with `RATE_LIMITED`, which stays retryable. Any other failure fails at once, with the last error. The worst case is one timeout (15 s) per endpoint per call. In the Worker each extra attempt is one more Cloudflare subrequest, and `REQUEST_BUDGET` counts calls, not attempts. So a scan that fails over a lot uses more of the per-run subrequest limit. Tests: `packages/key-doctor/test/rpc-failover.test.ts`.
3. NearBlocks stays out of the scan path: it cannot read `get_policy` / `get_proposal` or pin a block, and the free tier allows 6 calls per minute. The mainnet run confirmed that `/keys` returns `created` / `deleted`. That makes it a candidate for a later, optional "exact time this key was added" line on the key profile (Roadmap), next to the nonce estimate the rules use.
4. Next run: `pnpm bench` now also scans through the default failover list (`default list: … → …`), which shows what production gets. Run it on a DAO with a larger council, and once with `--burst 30`. `pnpm find-dao` lists testnet DAOs with the largest councils that a scan accepts (5 to `MAX_MEMBERS` accounts):

   ```bash
   pnpm find-dao --limit 500
   ```
