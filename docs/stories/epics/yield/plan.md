# Yield agent (plan)

Status: 2026-11-08, plan only. Nothing is built. Owner answered Y1–Y15 on 2026-11-04, deferred the agent the same day (B-Q9), and revived it on 2026-11-08 (Y17–Y20). YD0 is the go/no-go gate.

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
| Y4 | Can the agent execute? | No. Every move is a council vote. This plan does not extend the Guard. A self-running version inside Agent Budget is Roadmap: it would use a `PlanAction` `call` plan (ADR 0006) and needs a new owner decision |
| Y5 | Which model? | TEE models on NEAR AI only. Start with `Qwen/Qwen3.6-35B-A3B-FP8`, then `z-ai/glm-5.3-flash`, then the rule-ordered list. Never a non-TEE model. The first live test compares `deepseek-ai/DeepSeek-V4.1-Flash-1017`, which moves to first place if every run returns valid JSON and its Vietnamese is better. **Settled 2026-11-08 by the live compare:** Qwen with thinking off, then the rule order (YD2 note) |
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
| Y17 | Build it for the hackathon? (2026-11-08, reopens B-Q9) | Yes. V1 is an alert plus a council proposal. V2, where the agent supplies funds itself, stays Roadmap (Y4): Rhea protocol risk sits on large sums, and today's Budget role cannot run a `call` plan |
| Y18 | LLM? (2026-11-08) | Yes, ADR 0004 as written (§2). Not cut to the rule-only list |
| Y19 | Network? (2026-11-08) | Y3 stands: alerts show mainnet Rhea Lend rates, the proposal runs on testnet with `usdc.fakes.testnet` |
| Y20 | How often? (2026-11-08, replaces the daily push in Y11) | Code reads Rhea Lend every 15 minutes on its own cron offset, so it does not share CPU with the proposal job or the keeper. A push goes to opted-in chats only when the top candidate changes or its APR moves past a threshold that YD1 sets. The model runs only on such a change, never on a quiet cycle, so the key is not spent 96 times a day. DefiLlama is not read in the Worker: its response (~16k pools) would not parse within the 10 ms CPU limit |

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

Dates were reset on 2026-11-08 and assume YD0 starts on 9/11. Guard GĐ20–22 and GĐ14 go first if they compete for time.

| YD | Dates | Who | Done when |
|---|---|---|---|
| 0 spike | 9/11 | Claude writes, owner signs | A testnet DAO supplies and withdraws on Rhea through proposals, tx hashes recorded |
| 1 library | 9–10/11 | Claude | `scanVault`, collectors and rule filter pass fixture tests |
| 2 LLM step | 10–11/11 | Claude, owner sets the key | Validator and fallback tests pass with a fake model, then live calls and one verifier run |
| 3 surfaces | 11/11 | Claude | `/yield` and MCP `yield_suggestions` return the same report, and opt-in push works |
| 4 proposal builder | 12/11 | Claude | A dashboard proposal passes on testnet and funds return |
| 4b mainnet builder | after 4 | Claude builds, owner signs | A tiny mainnet supply and withdraw through proposals succeed, with no DAO name in the repo |
| 5 README | 13/11 | Claude | README steps reproduce, Limitations updated |
| XC cross-chain research | parallel | Claude | `docs/yield-crosschain-feasibility.md` gives go or no-go per protocol |

Cuts: YD0 not passing by 10/11 drops YD4 and YD4b, and suggestions stay read-only. YD2 not passing by 11/11 ships the rule-ordered list. YD4b (mainnet builder) is not expected before 14/11.

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

**Built 2026-11-08** (`src/yield/`: `rhea.ts`, `vault.ts`, `thresholds.ts`, `messages.ts`; tests in `test/yield.test.ts`). Changes against the sketch above:
- `readDefiLlama` is not built. Y20 keeps DefiLlama out of the Worker, so the second source is the Rhea API (`api.burrow.finance/list_token_data`, ~9 KB). It also gives the price: the on-chain Pyth prices for USDC and USDt were months old on 2026-11-08, and `priceoracle.near` returned none.
- The floors held on live data: native USDC TVL $12.8M, liquidity $1.86M, price 0.9998, APR 8.96% on both sources; USDt $12.6M, $1.98M, 0.9986, 7.28%. Liquidity is supplied minus borrowed and ignores the reserve, which is conservative.
- `YIELD_PUSH_APR_DELTA` = 0.005 (0.5 percentage point) for `shouldPushYield`.
- Open Transfers come from the newest 40 proposals (a limitation says so when there are more). A failed or unparseable read leaves `available` null and suggests nothing.
- Mainnet captures sit in `test/yield-data.ts`, not `fixtures/`, because `fixtures/` holds testnet names only.

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

**Built 2026-11-08, live run pending** (library `src/yield/advice.ts`, `src/yield/models.ts`, kd.yield_advice.v1 in `types.ts`; Worker `src/yield/agent.ts`, `migrations/0004_yield_advice.sql`; scripts `packages/key-doctor/scripts/compare-yield-models.ts` (`pnpm yield-models`) and `scripts/yield-setup/verify-tee.sh`; tests in `test/yield-advice.test.ts` and `apps/worker/test/yield.test.ts` with a fake model). Changes against the text above:
- The cache table is `yield_advice`, not `yield_suggestions`, so it does not share a name with the MCP tool. One row per DAO and network, model answers only; a fallback is never cached, so the next allowed caller tries again. Cached advice is reused while it is under a day old and the suggestions, amounts and APRs (within the push delta) still match.
- The model sees `adviceCandidates` (code facts in token units), gets no tools, and the body comes from one builder, `adviceRequest`, shared by the Worker and both scripts. The chain is `YIELD_MODEL_CHAIN`, checked against `YIELD_TEE_MODELS`; a model's extra request fields (`params`) live on its `YIELD_TEE_MODELS` entry.
- `validateAdvice` also drops reasons that carry a link, a handle, an account name or control characters, and accepts the number formats people write (8,96 in Vietnamese, 25k, $12.8M), each checked against that candidate's own evidence.
- Who may spend the key: the push job (only on a push, Y20) and bot `/yield` / `/yield_watch`, capped at `YIELD_MODEL_PER_MIN` = 6 model calls per minute per isolate. MCP `yield_suggestions` returns `advice` from the cache only, never calling the model. The rule order is marked with why: `NO_KEY` (no secret: no model call and no D1 read, same as YD3), `MODEL_FAILED`, `BUSY` (over the cap), `NO_CACHE` (MCP, nothing cached).
- Telegram shows the model's reason under each suggestion, plus one line naming the model, the TEE and the generation id, and saying every number comes from code.
- Y5 settled by the live compare on 2026-11-08 (`data/yield-model-compare.md`, 3 runs each on the synthetic testnet report). The chain is Qwen with `enable_thinking: false`, then the rule order:

  | Model | Valid | Latency | Why |
  |---|---|---|---|
  | Qwen 3.6, thinking off | 3/3 | ~1.9 s | Chosen |
  | Qwen 3.6, thinking on | 0/3 | ~5.8 s | Reasoning used all 1,200 tokens, no answer |
  | GLM 5.3 Flash | 3/3 | 18-23 s | Past the 9 s per-call timeout: on the chain it only delays the fallback |
  | DeepSeek V4.1 Flash 1017 | 0/3 | ~20 s | Same token cut as Qwen with thinking on, and slow |

  GLM and DeepSeek stay on `YIELD_TEE_MODELS`, so the verifier script can still check them.
- Deployed to testnet 2026-11-08 (Worker `37397e17`, `0004_yield_advice.sql` on remote D1). Not done yet: the verifier run (owner runs it with the key; the Worker secret is not readable locally) and a live model call from the Worker, which needs a DAO with a suggestion (YD0 funds one).

### YD3: surfaces

**What.** Bot `/yield <dao>`, rate-limited per chat. `/yield_watch <dao>` opts a chat in to the daily push, stored in a new D1 table `yield_watches`, not in `subscriptions`. The push runs inside the `0 2 * * *` cron and sends only when the top candidate differs from the last sent one. It follows the alert rule: send first, record after, and delete rows for chats that blocked the bot. MCP `yield_suggestions`, read-only and cached. Dashboard Yield panel on the DAO report. If `diagnose` finds a `high` flag on the council, the report leads with that warning.

**Why.** A proposal is only as safe as the council that votes on it, which is what ties this feature to Key Doctor. Security subscribers must not get yield messages they never asked for.

**Built 2026-11-08** (`apps/worker`: `src/jobs/yield.ts`, `src/store/yield.ts`, `migrations/0003_yield.sql`, `yieldCheck` in `src/core.ts`, `renderYield` in `src/telegram/render.ts`; tests in `test/yield.test.ts`). Changes against the text above:
- The push has its own cron, `11,26,41,56 * * * *` (Y20, every 15 minutes), not the `0 2 * * *` daily job. It pushes when the top suggestion changes or its APR moves by `YIELD_PUSH_APR_DELTA`. Any read error skips the push and keeps the state, so a long Rhea API outage also blocks pushes.
- MCP `yield_suggestions` runs a fresh, rule-ordered scan: no model, no D1, no key spent (`/mcp` is open, ADR 0003). YD2 adds the cached model advice as an `advice` field; MCP still never calls the model.
- Subrequest budget: one DAO costs about 10 subrequests, plus a council scan and one send per chat on a push. `MAX_YIELD_DAOS_PER_RUN` defaults to 1 (at most 3) and watched DAOs take turns, least recently checked first. With N watched DAOs, each one is checked every N × 15 minutes.
- `deleteChat` and `moveChat` now run as one D1 batch (one subrequest, atomic) and cover `yield_watches` as well as `subscriptions`.
- `/yield` and `/yield_watch` are rate-limited to 3 per chat per minute. `/yield` never writes D1. `/yield_watch` records the starting top only from a report with no read error.
- Not built: the dashboard Yield panel (moved to YD4, with the proposal builder). README lines wait for YD5.

### YD5: README

**Done 2026-11-08** for what is built (YD1–YD3). README: a Yield row in "What it does", an "AI in the product" paragraph that replaces "No AI is used in the product", step 9 (MCP `yield_suggestions` curl, checked live on `kdoncall.sputnik-v2.testnet`, and `pnpm yield-models`), Status rows YD1–YD3, a "Yield agent" section, three Limitations entries (suggestions only, TEE not verified per call and `verify-tee.sh` not run, rate and protocol risk), a Roadmap entry (YD4 panel and builder, YD4b, V2 self-farming), the optional `NEAR_AI_API_KEY` in Deploy, and the disclosure lines. To redo when YD0 or YD4 lands: step 9 (a DAO with a suggestion and a model order) and the Limitations entry on execution.

### YD4: proposal builder

**What.** `apps/dashboard/src/yield-proposals.ts` builds supply and withdraw proposals, reusing the base64 args helper in `guard-proposals.ts`. Allowlist per network: Rhea contract, known tokens, the methods proved in YD0. The existing proposal job watches the result.

**Why.** It turns a suggestion into a council vote without a new signer.

**Built 2026-11-09** (branch `feat/yield-my-agents`): `yield-proposals.ts` (testnet allowlist: `contract.1638481328.burrow.testnet` and `usdc.fakes.testnet`, with the args from `spike.sh`; register, supply, withdraw all; supply capped at the free balance), `yield-read.ts`, `yield-view.ts`, and the My Agents page (`agents-read.ts`, `agents-view.ts`). Council DAOs come from the Guard factory's `list_guards` plus Yield DAOs remembered in the browser. Not done: no proposal signed from the dashboard yet. The first dashboard supply and withdraw that pass on testnet also serve as the YD0 proof. Mainnet stays off (YD4b).

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
- Self-running supply and withdraw inside Agent Budget, as `PlanAction` `call` plans within the 24-hour limit (ADR 0006). Reopens Y4.
- Rhea DEX pools and farms, once APR and impermanent loss can be computed from a checked source.
- Reading strategy text from the open web, which needs its own injection review.
