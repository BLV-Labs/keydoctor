import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adviceCandidates,
  adviceFresh,
  advicePrompt,
  adviceRequest,
  isTeeModel,
  modelAdvice,
  orderSuggestions,
  ruleAdvice,
  validateAdvice,
  YIELD_ADVICE,
  YIELD_MODEL_CHAIN,
  YIELD_TEE_MODELS,
  type KdYieldReport,
  type YieldOpportunity,
} from "../src/index.ts";
import { YIELD_PUSH_APR_DELTA } from "../src/yield/thresholds.ts";

const DAO = "kd-demo.sputnik-dao.testnet";
const A = "rhea-lend:usdc.fakes.testnet:supply";
const B = "rhea-lend:usdt.fakes.testnet:supply";
const NOW = new Date("2026-11-08T10:00:00.000Z");

const opp = (id: string, token: string, symbol: string, apr: number, tvl: number, liquidity: number): YieldOpportunity => ({
  id,
  protocol: "rhea-lend",
  network: "testnet",
  token_id: token,
  symbol,
  apr,
  apy_reward: null,
  tvl_usd: tvl,
  liquidity_usd: liquidity,
  price_usd: 0.9998,
  sources: [{ name: "rhea-lend", apr, at: NOW.toISOString() }],
  executable: true,
  test_data: true,
  warnings: [],
});

/** Two suggestions in rule order: A (8.96%, 25,000 free of 30,000) before B (7.28%, 1,250 free). */
function report(over: Partial<KdYieldReport> = {}): KdYieldReport {
  return {
    schema_version: "kd.yield.v1",
    yield_ruleset_version: "test",
    generated_at: NOW.toISOString(),
    chain: { network: "testnet", block_height: 1, block_timestamp: NOW.toISOString() },
    dao: DAO,
    holdings: [
      { token_id: "usdc.fakes.testnet", symbol: "USDC (test)", decimals: 6, balance: "30000000000", open_transfers: [{ proposal_id: 7, amount: "5000000000" }], available: "25000000000", error: null },
      { token_id: "usdt.fakes.testnet", symbol: "USDT (test)", decimals: 6, balance: "1250000000", open_transfers: [], available: "1250000000", error: null },
    ],
    opportunities: [opp(A, "usdc.fakes.testnet", "USDC (test)", 0.0896, 12_800_000, 1_860_000), opp(B, "usdt.fakes.testnet", "USDT (test)", 0.0728, 12_600_000, 1_980_000)],
    rejected: [],
    suggestions: [
      { opportunity_id: A, token_id: "usdc.fakes.testnet", max_amount: "25000000000" },
      { opportunity_id: B, token_id: "usdt.fakes.testnet", max_amount: "1250000000" },
    ],
    notes: [],
    errors: [],
    limitations: [],
    ...over,
  };
}

const out = (order: unknown[]) => JSON.stringify({ order });
const item = (id: string, vi: string, en: string) => ({ opportunity_id: id, reason_vi: vi, reason_en: en });

describe("YD2: what the model sees", () => {
  it("one candidate per suggestion, in rule order, with token units instead of raw amounts", () => {
    const c = adviceCandidates(report());
    assert.deepEqual(c.map((x) => x.opportunity_id), [A, B]);
    assert.equal(c[0]?.apr_pct, 8.96);
    assert.equal(c[0]?.dao_free, 25_000);
    assert.equal(c[0]?.dao_balance, 30_000);
    assert.equal(c[0]?.open_transfers, 1);
  });

  it("no suggestion means no candidate, so the caller makes no call", () => {
    assert.deepEqual(adviceCandidates(report({ suggestions: [] })), []);
  });

  it("the prompt carries the candidates as JSON data and nothing else (no tools, no raw report)", () => {
    const c = adviceCandidates(report());
    const msgs = advicePrompt(c);
    assert.deepEqual(msgs.map((m) => m.role), ["system", "user"]);
    assert.deepEqual(JSON.parse(msgs[1]?.content as string), { candidates: c });
  });

  it("the request sends a schema only to structured-output models and never offers tools (plan §2)", () => {
    const c = adviceCandidates(report());
    const [qwen, , deepseek] = YIELD_TEE_MODELS;
    const structured = adviceRequest(qwen!, c);
    assert.equal(structured.model, qwen!.id);
    assert.equal(structured.temperature, 0);
    assert.ok("response_format" in structured);
    assert.deepEqual(structured.messages, advicePrompt(c));
    const free = adviceRequest(deepseek!, c);
    assert.equal(deepseek!.structured, false);
    assert.ok(!("response_format" in free));
    for (const body of [structured, free]) for (const k of ["tools", "tool_choice", "functions"]) assert.ok(!(k in body), k);
  });

  it("Qwen is sent with thinking off: with it on, the reasoning used up max_tokens and no answer came back (Y5)", () => {
    const qwen = YIELD_TEE_MODELS.find((m) => m.id === YIELD_MODEL_CHAIN[0])!;
    const body = adviceRequest(qwen, adviceCandidates(report()));
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.model, qwen.id, "params never override the fixed fields");
  });

  it("only models that answered inside the Worker timeout in the live compare are on the chain (Y5)", () => {
    assert.deepEqual([...YIELD_MODEL_CHAIN], ["Qwen/Qwen3.6-35B-A3B-FP8"]);
  });

  it("only TEE models are on the chain (plan §2: never a non-TEE model)", () => {
    assert.ok(YIELD_MODEL_CHAIN.length > 0);
    for (const id of YIELD_MODEL_CHAIN) assert.ok(isTeeModel(id), id);
    assert.equal(isTeeModel("deepseek/deepseek-v4.1-flash"), false);
    assert.ok(YIELD_TEE_MODELS.every((m) => m.id.includes("/") && !m.id.startsWith("deepseek/")));
  });
});

describe("YD2: validateAdvice", () => {
  const c = adviceCandidates(report());

  it("keeps the model order and both reasons when every number is in the candidate's evidence", () => {
    const got = validateAdvice(out([item(B, "Thanh khoản 1,98 triệu USD cao hơn.", "Liquidity of $1.98M is deeper."), item(A, "APR 8,96%.", "8.96% APR.")]), c);
    assert.deepEqual(got, [
      { opportunity_id: B, reason: { vi: "Thanh khoản 1,98 triệu USD cao hơn.", en: "Liquidity of $1.98M is deeper." } },
      { opportunity_id: A, reason: { vi: "APR 8,96%.", en: "8.96% APR." } },
    ]);
  });

  it("accepts the ways people round and write the same evidence", () => {
    for (const en of ["9% APR", "about 8.9%", "TVL $12.8M", "$12,800,000 TVL", "25k free", "25,000 free", "price near $1", "1 open transfer", "30,000.00 held"]) {
      assert.notEqual(validateAdvice(out([item(A, "Ổn.", en)]), c)?.[0]?.reason, null, en);
    }
    assert.notEqual(validateAdvice(out([item(A, "Còn tự do 25.000 USDC.", "Fine.")]), c)?.[0]?.reason, null, "vi thousands");
  });

  it("drops a reason with an invented number but keeps the candidate (a model must not make up yields)", () => {
    const got = validateAdvice(out([item(A, "APR 12%.", "12% APR next week.")]), c);
    assert.deepEqual(got?.[0], { opportunity_id: A, reason: null });
  });

  it("drops a reason that quotes another candidate's number: each reason is checked against its own evidence", () => {
    const got = validateAdvice(out([item(A, "Hơn 7,28%.", "Beats 7.28%.")]), c);
    assert.equal(got?.[0]?.reason, null);
  });

  it("drops a reason that calls the supply APR an APY: the council would read it as a compounded yield (Y5 live)", () => {
    const live = "This is the only option with a 8.96% APY and no warnings, despite being a testnet environment.";
    assert.equal(validateAdvice(out([item(A, "Ổn.", live)]), c)?.[0]?.reason, null);
    assert.equal(validateAdvice(out([item(A, "APY 8,96%.", "Fine.")]), c)?.[0]?.reason, null, "vi");
    assert.notEqual(validateAdvice(out([item(A, "Ổn.", live.replace("APY", "APR"))]), c)?.[0]?.reason, null);
  });

  it("with a reward APY, each percent must match the name next to it", () => {
    const withReward = report({ opportunities: [{ ...opp(A, "usdc.fakes.testnet", "USDC (test)", 0.0896, 12_800_000, 1_860_000), apy_reward: 0.015 }] });
    const cr = adviceCandidates(withReward);
    const reason = (en: string) => validateAdvice(out([item(A, "Ổn.", en)]), cr)?.[0]?.reason;
    assert.notEqual(reason("8.96% APR plus 1.5% APY in rewards."), null);
    assert.equal(reason("8.96% APY."), null, "APR named APY");
    assert.equal(reason("1.5% APR."), null, "APY named APR");
  });

  it("rejects unknown and repeated ids and puts the left-out candidates after, in rule order", () => {
    const got = validateAdvice(out([item("rhea-lend:evil.testnet:supply", "x", "x"), item(B, "Ổn.", "Fine."), item(B, "Lặp.", "Again.")]), c);
    assert.deepEqual(got?.map((x) => x.opportunity_id), [B, A]);
    assert.deepEqual(got?.[0]?.reason, { vi: "Ổn.", en: "Fine." });
    assert.equal(got?.[1]?.reason, null);
  });

  it("returns null (rule order) when nothing usable came back", () => {
    for (const raw of ["", "not json", "{}", out([]), out([item("other:id", "a", "b")]), JSON.stringify({ order: "A" }), null, 42]) {
      assert.equal(validateAdvice(raw, c), null, String(raw));
    }
  });

  it("reads JSON wrapped in a code fence or after a reasoning block (models without structured outputs)", () => {
    const body = out([item(A, "Ổn.", "Fine.")]);
    assert.equal(validateAdvice("```json\n" + body + "\n```", c)?.[0]?.opportunity_id, A);
    assert.equal(validateAdvice(`<think>maybe {"order": 1} first</think>\n${body}`, c)?.[0]?.opportunity_id, A);
  });

  it("drops reasons that could carry a link, a handle or an account into the chat", () => {
    for (const bad of ["See https://x.io", "Ask @someone", "Send to evil.near", "Use alice.testnet", "a‮b", "www.x.io"]) {
      assert.equal(validateAdvice(out([item(A, "Ổn.", bad)]), c)?.[0]?.reason, null, bad);
    }
  });

  it("drops a reason over the length cap and folds newlines into one line", () => {
    const long = "a".repeat(YIELD_ADVICE.max_reason_chars + 1);
    assert.equal(validateAdvice(out([item(A, "Ổn.", long)]), c)?.[0]?.reason, null);
    assert.deepEqual(validateAdvice(out([item(A, "Ổn\n định.", "Fine.")]), c)?.[0]?.reason, { vi: "Ổn định.", en: "Fine." });
  });
});

describe("YD2: cached advice", () => {
  const r = report();
  const items = validateAdvice(out([item(B, "Ổn.", "Fine."), item(A, "Ổn.", "Fine.")]), adviceCandidates(r)) ?? [];
  const cached = modelAdvice(r, "Qwen/Qwen3.6-35B-A3B-FP8", "chatcmpl-1", items, NOW);
  const later = (ms: number) => new Date(NOW.getTime() + ms);

  it("is reused for the same suggestions within a day", () => {
    assert.equal(adviceFresh(cached, r, later(60_000)), true);
  });

  it("is stale after a day, when an APR moves by the push delta, or when the free amount changes", () => {
    assert.equal(adviceFresh(cached, r, later(YIELD_ADVICE.max_age_ms)), false);
    const moved = report({ opportunities: r.opportunities.map((o) => (o.id === A ? { ...o, apr: o.apr + YIELD_PUSH_APR_DELTA } : o)) });
    assert.equal(adviceFresh(cached, moved, later(1)), false);
    const spent = report({ suggestions: r.suggestions.map((s) => (s.opportunity_id === A ? { ...s, max_amount: "1" } : s)) });
    assert.equal(adviceFresh(cached, spent, later(1)), false);
    assert.equal(adviceFresh(cached, report({ suggestions: r.suggestions.slice(0, 1) }), later(1)), false);
    assert.equal(adviceFresh(cached, report({ dao: "other.sputnik-dao.testnet" }), later(1)), false);
  });

  it("a rule-order fallback is never served as cached advice (the next call may reach the model)", () => {
    assert.equal(adviceFresh(ruleAdvice(r, "MODEL_FAILED", NOW), r, later(1)), false);
  });

  it("orderSuggestions applies the model order, and ignores advice for other suggestions", () => {
    assert.deepEqual(orderSuggestions(r, cached).map((x) => x.suggestion.opportunity_id), [B, A]);
    assert.deepEqual(orderSuggestions(r, ruleAdvice(r, "NO_KEY")).map((x) => x.suggestion.opportunity_id), [A, B]);
    const one = report({ suggestions: r.suggestions.slice(0, 1) });
    assert.deepEqual(orderSuggestions(one, cached).map((x) => x.suggestion.opportunity_id), [A]);
    assert.deepEqual(orderSuggestions(r, null).map((x) => x.reason), [null, null]);
  });
});
