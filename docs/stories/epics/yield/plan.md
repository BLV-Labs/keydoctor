# Yield agent (plan)

Status: 2026-11-04, plan only. Nothing is built. Owner decided Y1 (use an LLM). Y2–Y6 are recommendations and still need an owner answer. YD0 is the go/no-go gate.

Goal: an agent reads a DAO's treasury (the "vault"), compares it with live APR/APY from several sources, and sends the council suggestions for where idle assets could earn yield. Start with Rhea on NEAR. Other chains come later. The council acts on a suggestion through a normal Sputnik proposal.

Governing decision: [ADR 0004](../../../decisions/0004-llm-in-yield-agent.md). This work is outside `docs/final-idea.md` §13.3, so it comes after GĐ0–8, GĐ10 and GĐ14 and is the first thing to cut.

## 0. Today vs this plan

| | Today | This plan |
|---|---|---|
| Treasury view | Key and proposal checks only | Token balances plus Rhea Lend positions |
| Yield data | None | Rhea on chain, Rhea API, DefiLlama |
| LLM | None in the product | One step in the yield agent, through NEAR AI Cloud |
| Moving funds | Guard `Transfer` only | Council votes a `FunctionCall` proposal built by the dashboard |
| Who signs | Member wallet, or Guard agent key | Member wallet. No new signer |

## 1. Decisions

| # | Question | Answer |
|---|---|---|
| Y1 | Use an LLM? | Owner 2026-11-04: yes. Limits in §2 are a recommendation |
| Y2 | Scope before 14 Nov? | Recommended: Rhea suggestions plus proposal builder. Aave, Compound, Morpho and Curve appear for comparison only |
| Y3 | Network? | Recommended: run the flow on testnet Rhea. Intents has no testnet (HACKATHON Q-007), so use `dry: true` quotes only unless the owner approves a separate mainnet DAO with tiny amounts |
| Y4 | Can the agent execute? | Recommended: no. Every move is a council vote. Guard handles only `Transfer` and is not extended |
| Y5 | Which model? | Recommended: a NEAR AI model with `structured_outputs` and a TEE tier. `Qwen/Qwen3.6-35B-A3B-FP8` is the first candidate. Its privacy tier on `near.ai/models` is not checked yet, and no live call has been made |
| Y6 | Who pays for inference? | Recommended: one project key as Worker secret `NEAR_AI_API_KEY`, used only by the paths in §2. The hosted-agent BYOK idea stays Roadmap |

## 2. LLM boundary

Code owns every number and every transaction. The model only chooses among candidates and explains the choice.

| Step | Owner | Why |
|---|---|---|
| Fetch APR, TVL, liquidity, balances | Code | Facts must be reproducible |
| Filter candidates (allowlist, TVL floor, liquidity, source gap) | Code | A bad candidate must never reach the model |
| Order candidates, write the reasons in vi and en | LLM | Trade-offs between yield, risk and what the DAO holds are the judgment call |
| Check the model output | Code | Output is untrusted |
| Build proposal args | Code, from `opportunity_id` and the amount the member enters | A model must never produce a receiver, method or amount |
| Sign and vote | Member wallet, council | Unchanged invariant |

Rules:

- The model sees only the candidate list and DAO holdings. No open web browsing in this plan.
- Token symbols, pool names and proposal text are untrusted. They go in as data, and no tool calls are offered to the model.
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
| Lending APR, farms | `contract.main.burrow.near`, `get_assets_paged_detailed` | Works. `supply_apr` is a fraction (DAI `0.0552`) |
| Lending APY, liquidity | `api.burrow.finance/list_token_data` | Works |
| DEX pools | `indexer.ref.finance/list-top-pools` | Works, 2465 pools, needs gzip, no APR field |
| Cross-protocol yields | `yields.llama.fi/pools` | Works without a key, 15,933 pools. Slugs: `rhea-lend`, `rhea-dex`, `rhea-lst`, `aave-v3`, `compound-v3`, `morpho-blue`, `curve-dex`. Third-party pages disagree on whether it stays free |
| DAO token balances | FastNEAR `/v1/account/{id}/ft` | Works on both networks (`test.api.fastnear.com` on testnet) |
| Testnet lending | `contract.1638481328.burrow.testnet` | 9 assets. Rates are test data, for example `dai.fakes.testnet` at `2.4959` |
| Route cost | 1Click `POST /v0/quote`, `dry: true` | NEAR→NEAR works. NEAR→Base returned 400 `Internal server error` twice, cause unknown |
| Inference | `cloud-api.near.ai/v1/chat/completions`, `/v1/models` | Models list is public, 64 models. Chat call not tested, needs a key |

Known gaps:

- Sources disagree: USDC supply was 11.60 at the Rhea API and 11.27 at DefiLlama, cause unknown. DAI matched at 5.52. On-chain data wins, and a large gap removes the candidate.
- Intents swaps and bridges tokens. It does not deposit into a pool.
- `customRecipientMsg` on 1Click is marked experimental and can lose funds. Not used.
- A DAO has no EVM address, so Aave, Compound, Morpho and Curve execution needs Chain Signatures. Roadmap.
- The Rhea cross-chain SDK needs a wallet `sign_message`. Support for contract accounts is unknown.

## 4. Phases

Dates assume an owner answer by 5/11. Guard GĐ20–22 and GĐ14 go first if they compete for time.

| YD | Dates | Who | Done when |
|---|---|---|---|
| 0 spike | 5/11 | Claude writes, owner signs | A testnet DAO supplies and withdraws on Rhea through proposals, tx hashes recorded |
| 1 library | 5–6/11 | Claude | `scanVault`, collectors and rule filter pass fixture tests |
| 2 LLM step | 6–7/11 | Claude | Validator and fallback tests pass with a fake model, then one live call |
| 3 surfaces | 7–8/11 | Claude | `/yield` and MCP `yield_suggestions` return the same report |
| 4 proposal builder | 8–9/11 | Claude | A dashboard proposal passes on testnet and funds return |
| 5 README | 9–10/11 | Claude | README steps reproduce, Limitations updated |

Cuts: YD0 not passing by 6/11 drops YD4, and suggestions stay read-only. YD2 not passing by 8/11 ships the rule-ordered list.

### YD0: spike

**What.** `scripts/yield-setup/spike.sh` runs three proposals on a testnet DAO: `storage_deposit`, `ft_transfer_call` into Rhea, then `execute` with `Withdraw`. Results go to `docs/yield-spike-2026-11-05.md`.

**Why.** The DAO path is untested. Exact `msg`, storage cost, gas, and whether withdraw needs an oracle call are all unknown. The sample below is the expected shape, not a verified call.

```json
{ "proposal": { "description": "[KD-YIELD] supply 10 wNEAR", "kind": { "FunctionCall": {
  "receiver_id": "wrap.testnet",
  "actions": [{ "method_name": "ft_transfer_call", "deposit": "1", "gas": "150000000000000",
    "args": "<base64 of {receiver_id: contract.1638481328.burrow.testnet, amount, msg: \"\"}>" }]
} } } }
```

### YD1: library

**What.** New `packages/key-doctor/src/yield/`: `scanVault(dao)`, `readRheaLend`, `readDefiLlama`, and `filterCandidates` with limits in `yield/thresholds.ts`. New contract `kd.yield.v1` in `types.ts`, additive, so existing schemas do not change. Amounts stay strings. It stays `fetch` only and has no LLM code. Per-source failures go into `errors`, like `members[].error`.

**Why.** Dashboard, bot and MCP must share one result, and the rule list is the fallback when the model fails.

```ts
export interface YieldOpportunity {
  id: string; // "rhea-lend:wrap.testnet:supply"
  protocol: "rhea-lend"; network: "mainnet" | "testnet"; token_id: string;
  apr: number; apy_reward: number | null; tvl_usd: number | null; liquidity_usd: number | null;
  sources: { name: string; apr: number; at: string }[];
  executable: boolean; // false for comparison-only rows such as aave-v3
}
```

### YD2: LLM step

**What.** `apps/worker/src/yield/agent.ts` calls NEAR AI with a JSON schema, then `validateAdvice` applies §2. A new D1 table `yield_suggestions` caches one report per DAO per day. It does not touch `snapshots` or `subscriptions`.

**Why.** The model output is the one untrusted part of this flow, so its check must be small and fully tested.

```ts
export function validateAdvice(raw: unknown, candidates: YieldOpportunity[]): YieldAdvice[] | null {
  const parsed = parseAdvice(raw); // schema check; null falls back to the rule order
  if (!parsed) return null;
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return parsed.filter((a) => byId.has(a.opportunity_id)).map((a) => dropUnknownNumbers(a, byId.get(a.opportunity_id)!));
}
```

### YD3: surfaces

**What.** Bot `/yield <dao>`, rate-limited per chat. MCP `yield_suggestions`, read-only and cached. Dashboard Yield panel on the DAO report. If `diagnose` finds a `high` flag on the council, the report leads with that warning.

**Why.** A proposal is only as safe as the council that votes on it, which is what ties this feature to Key Doctor.

### YD4: proposal builder

**What.** `apps/dashboard/src/yield-proposals.ts` builds supply and withdraw proposals, reusing the base64 args helper in `guard-proposals.ts`. Allowlist per network: Rhea contract, known tokens, the methods proved in YD0. The existing proposal job watches the result.

**Why.** It turns a suggestion into a council vote without a new signer.

## 5. Tests

| Test | Why it matters |
|---|---|
| `filterCandidates` on TVL, liquidity and source gap | A thin or disputed pool must never be suggested |
| `validateAdvice` with unknown id, invented number, bad schema | A model mistake must not reach a council |
| Hostile token symbol in the candidate list | Injection must not change a proposal |
| LLM timeout falls back to the rule list | The feature must work when NEAR AI is down |
| Public MCP call makes no model call | An open endpoint must not spend the key |
| Proposal builder rejects a contract or method off the allowlist | Funds must only go where YD0 proved |
| Testnet report labels rates as test data | A judge must not read test rates as real yield |

## 6. Roadmap

- Execution on other chains through Chain Signatures and Intents.
- Rhea DEX pools and farms, once APR and impermanent loss can be computed from a checked source.
- Per-DAO yield policy, and Guard limits for `FunctionCall`.
- Reading strategy text from the open web, which needs its own injection review.
