# Yield agent (plan)

Status: 2026-11-04, plan only. Nothing is built. Owner answered Y1–Y15 on 2026-11-04. YD0 is the go/no-go gate.

Goal: an agent reads a DAO's treasury (the "vault"), compares it with live APR/APY from several sources, and sends the council suggestions for where stablecoins could earn yield. The council then moves the money from the DAO to Rhea and back through normal Sputnik proposals. Start with Rhea Lend on NEAR. Other chains come later.

"Farming" in v1 means supplying one stablecoin to Rhea Lend for interest, then withdrawing it. No stablecoin has a farm reward today (§3), so there is no claim step.

Governing decision: [ADR 0004](../../../decisions/0004-llm-in-yield-agent.md). This work is outside `docs/final-idea.md` §13.3, so it comes after GĐ0–8, GĐ10 and GĐ14 and is the first thing to cut.

## 0. Today vs this plan

| | Today | This plan |
|---|---|---|
| Treasury view | Key and proposal checks only | Token balances plus Rhea Lend positions |
| Yield data | None | Rhea on chain, Rhea API, DefiLlama |
| LLM | None in the product | One step in the yield agent, through NEAR AI Cloud, TEE models only |
| Moving funds | Guard `Transfer` only | Council votes a `FunctionCall` proposal built by the dashboard |
| Who signs | Member wallet, or Guard agent key | Member wallet. No new signer |

## 1. Decisions

All answered by the owner on 2026-11-04.

| # | Question | Answer |
|---|---|---|
| Y1 | Use an LLM? | Yes, with the limits in §2 |
| Y2 | Who and what before 14 Nov? | Sputnik DAO councils. Rhea Lend gets the full flow: suggestion plus proposal. Aave, Compound, Morpho and Curve appear for comparison only |
| Y3 | Network? | Testnet runs the full flow: a DAO farms test tokens on testnet Rhea, and the demo uses `usdc.fakes.testnet`. Mainnet rates are read for comparison. Intents has no testnet (HACKATHON Q-007), so `dry: true` quotes only |
| Y4 | Can the agent execute? | No. Every move is a council vote. Guard handles only `Transfer` and is not extended |
| Y5 | Which model? | TEE models on NEAR AI only. Start with `Qwen/Qwen3.6-35B-A3B-FP8`, then `z-ai/glm-5.3-flash`, then the rule-ordered list. Never a non-TEE model. The first live test compares `deepseek-ai/DeepSeek-V4.1-Flash-1017`, which moves to first place if every run returns valid JSON and its Vietnamese is better |
| Y6 | Who pays for inference? | One project key, Worker secret `NEAR_AI_API_KEY`, used only by the paths in §2 |
| Y7 | Which assets? | One stablecoin at a time. Mainnet: native USDC and USDt only. Bridged USDC.e and USDT.e and DAI are out because they add bridge risk. Testnet has its own allowlist. No LP, looping or LST |
| Y8 | Candidate floors? | Mainnet: TVL at least $1M, withdrawable liquidity at least $250k, price within 1% of $1, sources within 1 percentage point. APR above 30% warns but stays. The numbers are proposals, and YD1 checks them on real data |
| Y9 | Payroll money? | The suggested amount is the balance minus open `Transfer` proposals in the same token. The report always says to keep enough for payroll, because getting funds back needs another vote. The member enters the amount |
| Y10 | DAO with no eligible token? | Report that and show the rate table. No swap proposal |
| Y11 | How are suggestions sent? | `/yield <dao>` on demand, plus a daily push to chats that opted in, only when the top candidate changes. Existing subscribers get nothing: they signed up for security alerts |
| Y12 | Verify the TEE claim? | Not per request. A script runs the official verifier on one real call and records the result. Limitations says so |
| Y13 | Mainnet execution? | The proposal builder opens for mainnet only after YD4 passes on testnet (see YD4b). Allowlist: `contract.main.burrow.near` and `usdt.tether-token.near`. The first mainnet proposal uses a tiny amount and is withdrawn before any larger move. Mainnet DAO names stay out of the repo and the demo |
| Y14 | Priority? | Behind Guard GĐ20–22 and GĐ14. First to cut |
| Y15 | Cross-chain? | Research only, in `docs/yield-crosschain-feasibility.md`. It runs in parallel and does not block YD0 |
| Y16 | Can a relayer broadcast for cross-chain? | Yes. It only sends a tx the council already signed through `sign`, holds no key and cannot change the tx, so Y4 still holds. Applies only if cross-chain leaves Roadmap |

## 2. LLM boundary

Code owns every number and every transaction. The model only chooses among candidates and explains the choice.

| Step | Owner | Why |
|---|---|---|
| Fetch APR, TVL, liquidity, balances | Code | Facts must be reproducible |
| Filter candidates (allowlist, floors from Y8) | Code | A bad candidate must never reach the model |
| Order candidates, write the reasons in vi and en | LLM | Trade-offs between yield, risk and what the DAO holds are the judgment call |
| Check the model output | Code | Output is untrusted |
| Build proposal args | Code, from `opportunity_id` and the amount the member enters | A model must never produce a receiver, method or amount |
| Sign and vote | Member wallet, council | Unchanged invariant |

Rules:

- The model sees only the candidate list and DAO holdings. No open web browsing in this plan.
- Token symbols, pool names and proposal text are untrusted. They go in as data, and no tool calls are offered to the model.
- Only models on the TEE list in `yield/models.ts` may be called. A failure never falls through to a non-TEE model.
- Reject any `opportunity_id` that is not in the candidate list.
- Drop a reason if it contains a number that is not in that candidate's evidence.
- Any error, timeout or schema mismatch falls back to the rule-ordered list, marked as such.
- Mark AI text as AI-assisted. Keep the model id and generation id.
- `/mcp` is open (ADR 0003), so a public call must not spend the key. `yield_suggestions` serves cached output. Only the daily job and a rate-limited bot `/yield` may call the model.
- Scans, rules, `diffReports`, alerts and `preflight` stay LLM-free.

Output is filtered data and reasons, not financial advice, and `messages` say so in vi and en.

## 3. Source facts (checked 2026-11-04)

| Need | Source | Result |
|---|---|---|
| Lending APR, farms | `contract.main.burrow.near`, `get_assets_paged_detailed` | Works. `supply_apr` is a fraction. USDt `0.0717`, native USDC `0.1157`, USDT.e `0.0965`, USDC.e `0.0802`, DAI `0.0552`. All allow deposit and withdraw |
| Lending APY, liquidity | `api.burrow.finance/list_token_data` | Works |
| DEX pools | `indexer.ref.finance/list-top-pools` | Works, 2465 pools, needs gzip, no APR field |
| Cross-protocol yields | `yields.llama.fi/pools` | Works without a key, 15,933 pools. Slugs: `rhea-lend`, `rhea-dex`, `rhea-lst`, `aave-v3`, `compound-v3`, `morpho-blue`, `curve-dex`. Third-party pages disagree on whether it stays free |
| DAO token balances | FastNEAR `/v1/account/{id}/ft` | Works on both networks (`test.api.fastnear.com` on testnet) |
| Testnet lending | `contract.1638481328.burrow.testnet` | 9 assets. Rates are test data: `usdc.fakes.testnet` `0.1041`, `usdt.fakes.testnet` `0.0000`, `dai.fakes.testnet` `2.4958`. All three allow deposit and withdraw |
| Farm rewards | `farms` in the same call | Testnet: only `wrap.testnet` pays one, `test_brrr.1638481328.burrow.testnet`. Mainnet: none on the five stablecoins above |
| Test tokens | `*.fakes.testnet` code | All three export `mint`. Who may call it is untested |
| Route cost | 1Click `POST /v0/quote`, `dry: true` | NEAR→NEAR works. NEAR→Base returned 400 `Internal server error` twice, cause unknown |
| Inference | `cloud-api.near.ai/v1/chat/completions`, `/v1/models` | Models list is public, 64 models. Chat call not tested, needs a key |
| TEE models | `near.ai/models` tiers, `/v1/models` features | Private TEE with `structured_outputs` and ready: `Qwen/Qwen3.6-35B-A3B-FP8`, `Qwen/Qwen3.8-27B`, `z-ai/glm-5.3-flash`. `deepseek-ai/DeepSeek-V4.1-Flash-1017` is Private TEE with neither `structured_outputs` nor `json_mode`, so code must parse its JSON, and `is_ready` is empty |
| TEE verification | `nearai/nearai-cloud-verifier` (Python, TypeScript), `cloud.near.ai/verify` | Checks the attestation report and the response signature. The TypeScript path uses `dcap-qvl-node`, not checked on Workers |

Known gaps:

- Sources disagree: USDC supply was 11.60 at the Rhea API and 11.27 at DefiLlama, cause unknown. DAI matched at 5.52. On-chain data wins, and a large gap removes the candidate.
- Intents swaps and bridges tokens. It does not deposit into a pool.
- `customRecipientMsg` on 1Click is marked experimental and can lose funds. Not used.
- A DAO has no EVM address, so Aave, Compound, Morpho and Curve execution needs Chain Signatures. Roadmap.
- The Rhea cross-chain SDK needs a wallet `sign_message`. Support for contract accounts is unknown.
- The testnet and mainnet Rhea contracts may be different versions, so a testnet pass does not prove mainnet.

## 4. Phases

Dates assume YD0 starts on 5/11. Guard GĐ20–22 and GĐ14 go first if they compete for time.

| YD | Dates | Who | Done when |
|---|---|---|---|
| 0 spike | 5/11 | Claude writes, owner signs | A testnet DAO supplies and withdraws on Rhea through proposals, tx hashes recorded |
| 1 library | 5–6/11 | Claude | `scanVault`, collectors and rule filter pass fixture tests |
| 2 LLM step | 6–7/11 | Claude, owner sets the key | Validator and fallback tests pass with a fake model, then live calls and one verifier run |
| 3 surfaces | 7–8/11 | Claude | `/yield` and MCP `yield_suggestions` return the same report, and opt-in push works |
| 4 proposal builder | 8–9/11 | Claude | A dashboard proposal passes on testnet and funds return |
| 4b mainnet builder | after 4 | Claude builds, owner signs | A tiny mainnet supply and withdraw through proposals succeed, with no DAO name in the repo |
| 5 README | 9–10/11 | Claude | README steps reproduce, Limitations updated |
| XC cross-chain research | parallel | Claude | `docs/yield-crosschain-feasibility.md` gives go or no-go per protocol |

Cuts: YD0 not passing by 6/11 drops YD4 and YD4b, and suggestions stay read-only. YD2 not passing by 8/11 ships the rule-ordered list.

### YD0: spike

**What.** `scripts/yield-setup/spike.sh` gets `usdc.fakes.testnet` into a testnet DAO through `mint`, then runs three proposals: `storage_deposit`, `ft_transfer_call` into Rhea, then `execute` with `Withdraw`. Results go to `docs/yield-spike-2026-11-05.md`.

**Why.** The DAO path is untested. Exact `msg`, storage cost, gas, and whether withdraw needs an oracle call are all unknown. If `mint` is restricted, the spike reports that and looks for another token source. The sample below is the expected shape, not a verified call.

```json
{ "proposal": { "description": "[KD-YIELD] supply 10 USDC", "kind": { "FunctionCall": {
  "receiver_id": "usdc.fakes.testnet",
  "actions": [{ "method_name": "ft_transfer_call", "deposit": "1", "gas": "150000000000000",
    "args": "<base64 of {receiver_id: contract.1638481328.burrow.testnet, amount, msg: \"\"}>" }]
} } } }
```

### YD1: library

**What.** New `packages/key-doctor/src/yield/`: `scanVault(dao)`, `readRheaLend`, `readDefiLlama`, and `filterCandidates` with limits and per-network allowlists in `yield/thresholds.ts`. `scanVault` reads open `Transfer` proposals and returns the available amount per token. New contract `kd.yield.v1` in `types.ts`, additive, so existing schemas do not change. Amounts stay strings. It stays `fetch` only and has no LLM code. Per-source failures go into `errors`, like `members[].error`.

The Y8 floors apply on mainnet only, because testnet TVL and prices mean nothing. Testnet rows skip them and carry a test-data label.

**Why.** Dashboard, bot and MCP must share one result, and the rule list is the fallback when the model fails. Payroll money sits in the same treasury, so a suggestion must not count funds a pending payment already needs.

```ts
export interface YieldOpportunity {
  id: string; // "rhea-lend:usdc.fakes.testnet:supply"
  protocol: "rhea-lend"; network: "mainnet" | "testnet"; token_id: string;
  apr: number; apy_reward: number | null; tvl_usd: number | null; liquidity_usd: number | null;
  sources: { name: string; apr: number; at: string }[];
  executable: boolean; // false for comparison-only rows such as aave-v3
}

export const YIELD_LIMITS = {
  min_tvl_usd: 1_000_000, min_liquidity_usd: 250_000,
  max_price_gap: 0.01, max_source_gap: 0.01, warn_apr: 0.3,
};

export function availableAmount(balance: string, openTransfers: string[]): string {
  const left = openTransfers.reduce((sum, a) => sum - BigInt(a), BigInt(balance));
  return left > 0n ? left.toString() : "0";
}
```

### YD2: LLM step

**What.** `apps/worker/src/yield/agent.ts` calls NEAR AI with a JSON schema, then `validateAdvice` applies §2. A new D1 table `yield_suggestions` caches one report per DAO per day. It does not touch `snapshots` or `subscriptions`. The first live test runs the same candidates through Qwen and DeepSeek and settles Y5. `scripts/yield-setup/verify-tee.sh` runs `nearai-cloud-verifier` on one real call and writes `docs/yield-tee-verify.md`, so a judge can rerun it.

**Why.** The model output is the one untrusted part of this flow, so its check must be small and fully tested. The TEE claim needs evidence, not only a tier label.

```ts
export function validateAdvice(raw: unknown, candidates: YieldOpportunity[]): YieldAdvice[] | null {
  const parsed = parseAdvice(raw); // schema check; null falls back to the rule order
  if (!parsed) return null;
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return parsed.filter((a) => byId.has(a.opportunity_id)).map((a) => dropUnknownNumbers(a, byId.get(a.opportunity_id)!));
}
```

### YD3: surfaces

**What.** Bot `/yield <dao>`, rate-limited per chat. `/yield_watch <dao>` opts a chat in to the daily push, stored in a new D1 table `yield_watches`, not in `subscriptions`. The push runs inside the `0 2 * * *` cron and sends only when the top candidate differs from the last sent one. It follows the alert rule: send first, record after, and delete rows for chats that blocked the bot. MCP `yield_suggestions`, read-only and cached. Dashboard Yield panel on the DAO report. If `diagnose` finds a `high` flag on the council, the report leads with that warning.

**Why.** A proposal is only as safe as the council that votes on it, which is what ties this feature to Key Doctor. Security subscribers must not get yield messages they never asked for.

### YD4: proposal builder

**What.** `apps/dashboard/src/yield-proposals.ts` builds supply and withdraw proposals, reusing the base64 args helper in `guard-proposals.ts`. Allowlist per network: Rhea contract, known tokens, the methods proved in YD0. The existing proposal job watches the result.

**Why.** It turns a suggestion into a council vote without a new signer.

### YD4b: mainnet builder

**What.** After YD4, add the mainnet allowlist from Y13. The owner runs a tiny supply and a withdraw on the real DAO, then records the args that differed from testnet. Tx hashes and the DAO name stay out of the repo.

**Why.** The DAO's USDt is real money, and the testnet contract may not match mainnet. A tiny round trip is the only proof before a larger move. Withdraw must be proved first, because funds that cannot return are the worst failure here.

## 5. Tests

| Test | Why it matters |
|---|---|
| `filterCandidates` on TVL, liquidity, price and source gap | A thin, depegged or disputed pool must never be suggested |
| Bridged token on mainnet is filtered out | Y7 keeps bridge risk away from a treasury |
| `availableAmount` with open `Transfer` proposals | Money already promised must not be suggested for farming |
| DAO with no eligible token gets a report and no proposal | The agent must not push a swap the council did not ask for |
| `validateAdvice` with unknown id, invented number, bad schema | A model mistake must not reach a council |
| Hostile token symbol in the candidate list | Injection must not change a proposal |
| LLM timeout falls back to the rule list | The feature must work when NEAR AI is down |
| Model off the TEE list is refused | Y5 must hold when a failure tries the next model |
| Public MCP call makes no model call | An open endpoint must not spend the key |
| Push goes only to opted-in chats, only on a changed top candidate | Security subscribers must not get yield messages |
| Proposal builder rejects a contract or method off the allowlist | Funds must only go where YD0 proved |
| Testnet report labels rates as test data | A judge must not read test rates as real yield |

## 6. Roadmap

- Execution on other chains through Chain Signatures and Intents, if `docs/yield-crosschain-feasibility.md` says go.
- Personal wallets as a user type.
- A per-user NEAR AI key.
- Farm reward claims, once a stablecoin pays one.
- Swap proposals through Intents for a DAO with no eligible token.
- Per-DAO reserve settings and a payroll schedule, and Guard limits for `FunctionCall`.
- Attestation checks on every model call.
- Rhea DEX pools and farms, once APR and impermanent loss can be computed from a checked source.
- Reading strategy text from the open web, which needs its own injection review.
