import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import {
  availableAmount,
  filterCandidates,
  readRheaLend,
  scanVault,
  shouldPushYield,
  YIELD_LIMITS,
  YIELD_RULESET_VERSION,
  type RheaRow,
} from "../src/index.ts";
import { NO_SUGGESTION_NOTE, PAYROLL_NOTE, REFERENCE_NOTE, TEST_DATA_NOTE } from "../src/yield/messages.ts";
import { RHEA_API_URL, RHEA_LEND_CONTRACT } from "../src/yield/thresholds.ts";
import { blockBody, fixture, ok, rpcErr } from "./support/stub.ts";
import { MAINNET_API, MAINNET_ASSETS } from "./yield-data.ts";

const DAO = "kd-demo.sputnik-dao.testnet";
const USDC_T = "usdc.fakes.testnet";
const USDT_M = "usdt.tether-token.near";
const USDC_M = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_E = "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near";

const bytes = (v: unknown) => ok({ result: Array.from(new TextEncoder().encode(JSON.stringify(v))), logs: [], block_height: 1, block_hash: "h" });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

interface World {
  balance?: unknown;
  last?: unknown;
  proposals?: unknown;
  /** Reply for the Rhea API GET; default the 2026-11-08 capture. */
  api?: Response | (() => Response);
  policy?: unknown;
}

interface Call {
  url: string;
  method: string;
  account?: string;
  fn?: string;
  args?: Record<string, unknown>;
}

/** Answers JSON-RPC by account and view method, and the Rhea API GET by URL. */
function installYield(t: TestContext, w: World = {}): Call[] {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "GET") {
      calls.push({ url, method: "GET" });
      assert.equal(url, RHEA_API_URL);
      const api = w.api ?? json(MAINNET_API);
      return typeof api === "function" ? api() : api;
    }
    const sent = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    const p = sent.params;
    const call: Call = { url, method: sent.method };
    if (typeof p.account_id === "string") call.account = p.account_id;
    if (typeof p.method_name === "string") {
      call.fn = p.method_name;
      call.args = JSON.parse(atob(String(p.args_base64))) as Record<string, unknown>;
    }
    calls.push(call);
    if (sent.method === "block") return json(blockBody());
    const reply = (() => {
      if (call.account === RHEA_LEND_CONTRACT.testnet && call.fn === "get_assets_paged_detailed") return bytes(fixture("yield/rhea-lend.assets.json"));
      if (call.account === RHEA_LEND_CONTRACT.mainnet && call.fn === "get_assets_paged_detailed") return bytes(MAINNET_ASSETS);
      if (call.account === DAO && call.fn === "get_policy") return w.policy ?? bytes(fixture("sputnik/get_policy.json"));
      if (call.account === DAO && call.fn === "get_last_proposal_id") return w.last ?? bytes(5);
      if (call.account === DAO && call.fn === "get_proposals") return w.proposals ?? bytes(fixture("yield/get_proposals.vault.json"));
      if (call.account === USDC_T && call.fn === "ft_balance_of") return w.balance ?? bytes("20000000");
      return rpcErr("UNKNOWN_ACCOUNT");
    })();
    return reply instanceof Response ? reply : json(reply);
  });
  return calls;
}

const row = (over: Partial<RheaRow> = {}): RheaRow => ({
  network: "mainnet",
  token_id: USDT_M,
  apr: 0.07,
  apy_reward: 0,
  tvl_usd: 12_000_000,
  liquidity_usd: 2_000_000,
  price_usd: 1,
  sources: [
    { name: "rhea-lend", apr: 0.07, at: "2026-11-08T00:00:00Z" },
    { name: "rhea-api", apr: 0.07, at: "2026-11-08T00:00:00Z" },
  ],
  can_deposit: true,
  can_withdraw: true,
  ...over,
});

const reasonsOf = (r: RheaRow) => {
  const out = filterCandidates([r], "mainnet");
  return out.opportunities.length === 1 ? [] : (out.rejected[0]?.reasons ?? ["MISSING"]);
};

describe("filterCandidates: Y8 floors keep a council away from thin, unpegged or unconfirmed markets", () => {
  it("a healthy native stablecoin row passes with its allowlist symbol", () => {
    const { opportunities, rejected } = filterCandidates([row()], "mainnet");
    assert.equal(rejected.length, 0);
    assert.equal(opportunities[0]?.symbol, "USDt");
    assert.equal(opportunities[0]?.executable, true);
    assert.equal(opportunities[0]?.test_data, false);
  });

  it("each floor rejects on its own, just past the limit", () => {
    const L = YIELD_LIMITS;
    assert.deepEqual(reasonsOf(row({ tvl_usd: L.min_tvl_usd - 1 })), ["TVL_LOW"]);
    assert.deepEqual(reasonsOf(row({ liquidity_usd: L.min_liquidity_usd - 1 })), ["LIQUIDITY_LOW"]);
    assert.deepEqual(reasonsOf(row({ price_usd: 1 - L.max_price_gap - 0.001 })), ["PRICE_GAP"]);
    assert.deepEqual(reasonsOf(row({ price_usd: null, tvl_usd: null, liquidity_usd: null })), ["PRICE_UNKNOWN"]);
    assert.deepEqual(reasonsOf(row({ sources: [row().sources[0]!] })), ["SOURCE_MISSING"]);
    const gap = row().sources.map((s, i) => ({ ...s, apr: i === 0 ? 0.07 : 0.07 + L.max_source_gap + 0.001 }));
    assert.deepEqual(reasonsOf(row({ sources: gap })), ["SOURCE_GAP"]);
    assert.deepEqual(reasonsOf(row({ can_deposit: false })), ["DEPOSIT_CLOSED"]);
    assert.deepEqual(reasonsOf(row({ can_withdraw: false })), ["WITHDRAW_CLOSED"]);
  });

  it("values exactly at a limit still pass (floors are strict)", () => {
    const L = YIELD_LIMITS;
    assert.deepEqual(reasonsOf(row({ tvl_usd: L.min_tvl_usd, liquidity_usd: L.min_liquidity_usd })), []);
  });

  it("bridged USDC.e is rejected even with a good rate: bridge risk is not on the allowlist", () => {
    assert.deepEqual(reasonsOf(row({ token_id: USDC_E })), ["NOT_ALLOWLISTED"]);
  });

  it("testnet rows skip the floors (test data has no price) but keep the allowlist", () => {
    const t = row({ network: "testnet", token_id: USDC_T, price_usd: null, tvl_usd: null, liquidity_usd: null, sources: [row().sources[0]!] });
    const { opportunities } = filterCandidates([t], "testnet");
    assert.equal(opportunities[0]?.test_data, true);
    assert.deepEqual(reasonsOf({ ...t, token_id: "usdt.fakes.testnet" }), ["NOT_ALLOWLISTED"]);
  });

  it("a row is executable only on the DAO's own network", () => {
    const { opportunities } = filterCandidates([row()], "testnet");
    assert.equal(opportunities[0]?.executable, false);
  });

  it("APR above warn_apr stays but carries APR_HIGH", () => {
    const { opportunities } = filterCandidates([row({ apr: YIELD_LIMITS.warn_apr + 0.01 })], "mainnet");
    assert.deepEqual(opportunities[0]?.warnings, ["APR_HIGH"]);
  });

  it("sorts highest APR first, then by id", () => {
    const { opportunities } = filterCandidates([row({ apr: 0.05 }), row({ token_id: USDC_M, apr: 0.09 })], "mainnet");
    assert.deepEqual(opportunities.map((o) => o.symbol), ["USDC", "USDt"]);
  });

  it("an unreadable token id never reaches the output", () => {
    const { rejected } = filterCandidates([row({ token_id: "<b>evil</b>" })], "mainnet");
    assert.equal(rejected[0]?.token_id, "?");
  });
});

describe("readRheaLend (mainnet capture 2026-11-08)", () => {
  it("native USDC and USDt pass with chain TVL, conservative liquidity and two sources", async (t) => {
    installYield(t);
    const { rows, errors } = await readRheaLend("mainnet", { blockHeight: 1 });
    assert.deepEqual(errors, []);
    const { opportunities, rejected } = filterCandidates(rows, "mainnet");
    assert.deepEqual(opportunities.map((o) => o.token_id), [USDC_M, USDT_M]);
    const usdt = opportunities.find((o) => o.token_id === USDT_M)!;
    assert.ok(Math.abs(usdt.tvl_usd! - 12.57e6) < 0.05e6, String(usdt.tvl_usd));
    assert.ok(Math.abs(usdt.liquidity_usd! - 1.98e6) < 0.05e6, String(usdt.liquidity_usd));
    assert.deepEqual(usdt.sources.map((s) => s.name), ["rhea-lend", "rhea-api"]);
    assert.ok(Math.abs(usdt.sources[1]!.apr - 0.0728) < 1e-9);
    assert.deepEqual(rejected.find((r) => r.token_id === USDC_E)?.reasons, ["NOT_ALLOWLISTED"]);
  });

  it("an API failure fails closed: no price, one source, every mainnet row rejected", async (t) => {
    installYield(t, { api: () => json({}, 500) });
    const { rows, errors } = await readRheaLend("mainnet", { blockHeight: 1 });
    assert.deepEqual(errors, ["rhea-api: RPC_ERROR"]);
    const { opportunities, rejected } = filterCandidates(rows, "mainnet");
    assert.equal(opportunities.length, 0);
    assert.deepEqual(rejected.find((r) => r.token_id === USDT_M)?.reasons, ["PRICE_UNKNOWN", "SOURCE_MISSING"]);
  });

  it("API text (symbol) is never copied into the output", async (t) => {
    const hostile = { ...MAINNET_API, data: MAINNET_API.data.map((d) => ({ ...d, symbol: "<script>HOSTILE</script>" })) };
    installYield(t, { api: () => json(hostile) });
    const { rows } = await readRheaLend("mainnet", { blockHeight: 1 });
    assert.doesNotMatch(JSON.stringify(filterCandidates(rows, "mainnet")), /HOSTILE/);
  });

  it("testnet reads no API and leaves price, TVL and liquidity null", async (t) => {
    const calls = installYield(t);
    const { rows } = await readRheaLend("testnet", { blockHeight: 1 });
    assert.equal(calls.filter((c) => c.method === "GET").length, 0);
    const usdc = rows.find((r) => r.token_id === USDC_T)!;
    assert.equal(usdc.price_usd, null);
    assert.equal(usdc.tvl_usd, null);
    assert.ok(Math.abs(usdc.apr - 0.1053) < 0.001);
  });
});

describe("availableAmount: Y9 money already promised in an open Transfer is not free to supply", () => {
  it("subtracts every open transfer", () => {
    assert.equal(availableAmount("20000000", [{ amount: "2500000" }, { amount: "1000000" }]), "16500000");
  });
  it("never goes below zero", () => {
    assert.equal(availableAmount("1000", [{ amount: "5000" }]), "0");
  });
});

describe("shouldPushYield: no spam on noise, a push on a real change", () => {
  it("same top, small move: no push", () => assert.equal(shouldPushYield({ id: "a", apr: 0.07 }, { id: "a", apr: 0.0749 }), false));
  it("same top, move of at least the delta: push", () => assert.equal(shouldPushYield({ id: "a", apr: 0.07 }, { id: "a", apr: 0.0751 }), true));
  it("new top: push", () => assert.equal(shouldPushYield({ id: "a", apr: 0.07 }, { id: "b", apr: 0.07 }), true));
  it("to or from none: push; none to none: no push", () => {
    assert.equal(shouldPushYield(null, { id: "a", apr: 0.07 }), true);
    assert.equal(shouldPushYield({ id: "a", apr: 0.07 }, null), true);
    assert.equal(shouldPushYield(null, null), false);
  });
});

describe("scanVault (testnet DAO, mainnet reference)", () => {
  it("suggests at most what is free after open transfers, on the DAO's network only", async (t) => {
    const calls = installYield(t);
    const r = await scanVault(DAO);
    assert.equal(r.schema_version, "kd.yield.v1");
    assert.equal(r.yield_ruleset_version, YIELD_RULESET_VERSION);
    const h = r.holdings[0]!;
    assert.equal(h.balance, "20000000");
    assert.deepEqual(h.open_transfers.map((x) => x.proposal_id), [1, 4]);
    assert.equal(h.available, "16500000");
    assert.deepEqual(r.suggestions, [{ opportunity_id: `rhea-lend:${USDC_T}:supply`, token_id: USDC_T, max_amount: "16500000" }]);
    assert.ok(r.opportunities.some((o) => o.network === "mainnet" && !o.executable));
    assert.ok(r.opportunities.filter((o) => o.executable).every((o) => o.network === "testnet" && o.test_data));
    assert.deepEqual(r.notes, [PAYROLL_NOTE, TEST_DATA_NOTE, REFERENCE_NOTE]);
    assert.deepEqual(r.errors, []);
    // The DAO-network rates are pinned to the scan block.
    const testnetRates = calls.find((c) => c.account === RHEA_LEND_CONTRACT.testnet)!;
    assert.ok(testnetRates.url.includes("testnet"));
    assert.deepEqual(calls.find((c) => c.fn === "get_proposals")?.args, { from_index: 0, limit: 40 });
  });

  it("a DAO with nothing eligible gets a report, no suggestion and the no-swap note", async (t) => {
    installYield(t, { balance: bytes("0") });
    const r = await scanVault(DAO, { referenceMainnet: false });
    assert.deepEqual(r.suggestions, []);
    assert.deepEqual(r.notes, [PAYROLL_NOTE, TEST_DATA_NOTE, NO_SUGGESTION_NOTE]);
  });

  it("unreadable proposals fail closed: nothing is free, nothing is suggested", async (t) => {
    installYield(t, { proposals: json({}, 500) });
    const r = await scanVault(DAO, { referenceMainnet: false });
    assert.equal(r.holdings[0]?.available, null);
    assert.deepEqual(r.suggestions, []);
    assert.deepEqual(r.errors, ["proposals: RPC_ERROR"]);
    assert.ok(!r.notes.includes(NO_SUGGESTION_NOTE));
  });

  it("an open Transfer it cannot parse also fails closed", async (t) => {
    const bad = [{ id: 9, status: "InProgress", kind: { Transfer: { token_id: USDC_T, amount: 5 } } }];
    installYield(t, { proposals: bytes(bad) });
    const r = await scanVault(DAO, { referenceMainnet: false });
    assert.deepEqual(r.suggestions, []);
  });

  it("only the newest proposals are read, and the report says so", async (t) => {
    const calls = installYield(t, { last: bytes(45) });
    const r = await scanVault(DAO, { referenceMainnet: false });
    assert.deepEqual(calls.find((c) => c.fn === "get_proposals")?.args, { from_index: 5, limit: 40 });
    assert.equal(r.limitations.length, 1);
  });

  it("a balance read failure drops that suggestion only", async (t) => {
    installYield(t, { balance: rpcErr("UNKNOWN_BLOCK") });
    const r = await scanVault(DAO, { referenceMainnet: false });
    assert.equal(r.holdings[0]?.error, "RPC_ERROR");
    assert.deepEqual(r.suggestions, []);
  });

  it("a non-DAO account throws NOT_A_DAO", async (t) => {
    installYield(t, { policy: bytes({ nope: true }) });
    await assert.rejects(scanVault(DAO), (e: any) => e.kd?.code === "NOT_A_DAO");
  });
});
