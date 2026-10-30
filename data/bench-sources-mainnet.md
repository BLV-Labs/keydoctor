### mainnet · 2026-10-30T01:59:52Z

Runs per call: 5. Account: 32 keys. NearBlocks API key: no (free tier).

| Source | Call | OK | p50 ms | p95 ms | min–max ms | Errors |
|---|---|---|---|---|---|---|
| rpc.mainnet.near.org | block (final) | 5/5 | 3137 | 3157 | 3090–3157 | – |
| rpc.mainnet.near.org | view_access_key_list | 5/5 | 3099 | 3157 | 3092–3157 | – |
| rpc.mainnet.near.org | view_account | 5/5 | 3089 | 3127 | 3082–3127 | – |
| rpc.mainnet.near.org | full scan (1 members) | 2/5 | 12633 | 28074 | 12633–28074 | 3× 429 |
| rpc.mainnet.fastnear.com | block (final) | 5/5 | 88 | 260 | 86–260 | – |
| rpc.mainnet.fastnear.com | view_access_key_list | 5/5 | 87 | 115 | 80–115 | – |
| rpc.mainnet.fastnear.com | view_account | 5/5 | 86 | 155 | 78–155 | – |
| rpc.mainnet.fastnear.com | full scan (1 members) | 4/5 | 843 | 935 | 825–935 | 1× 429 |
| NearBlocks API (api.nearblocks.io) | GET /v1/account/{id} | 5/5 | 425 | 1171 | 388–1171 | – |
| NearBlocks API (api.nearblocks.io) | GET /v1/account/{id}/keys | 5/5 | 507 | 1241 | 413–1241 | – |

NearBlocks key entry fields: `account_id`, `created`, `deleted`, `permission_kind`, `public_key`.
