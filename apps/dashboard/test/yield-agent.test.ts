import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KdYieldReport } from "key-doctor";
import { parseRoute, yieldNewHref } from "../src/route.ts";
import { reviewSentence, suggest, suggestedAmount, type SuggestInput } from "../src/yield-agent.ts";
import { renderYieldCreate, type CreateView } from "../src/yield-create.ts";
import { parseSettings, validateSettings, type YieldSettings } from "../src/yield-settings.ts";
import { YIELD_PREFIX, supplyProposal } from "../src/yield-proposals.ts";
import type { YieldLive } from "../src/yield-read.ts";
import { renderYield, renderYieldLimits } from "../src/yield-view.ts";

const USDC = "usdc.fakes.testnet";
const DAO = "demo.sputnikv2.testnet";
const ctx = { decimals: 6, symbol: "USDC (test)", ceiling: "20000000" };
const S: YieldSettings = { maxPut: "10000000", keepReady: "2000000", minApr: 0.03, checkEvery: "1h", mode: "suggest", paused: false };
const base = (over: Partial<SuggestInput> = {}): SuggestInput => ({ settings: S, apr: 0.05, idle: "20000000", supplied: "0", registered: true, decimals: 6, symbol: "USDC (test)", ...over });

// The jargon tests strip the Technical details card and the tags, as the slice-5 tests do.
const JARGON = /\bDAO\b|\b[Pp]roposals?\b|\bGuard\b|[Pp]olicy|[Ww]hitelist|yocto/;
const words = (h: string) => h.replace(/<details class="card tech">[\s\S]*?<\/details>/g, "").replace(/<[^>]+>/g, " ");

function live(network: "testnet" | "mainnet" = "testnet", over: Partial<YieldLive> = {}): YieldLive {
  const report: KdYieldReport = {
    schema_version: "kd.yield.v1", yield_ruleset_version: "y1", generated_at: "2026-11-09T00:00:00Z",
    chain: { network, block_height: 1, block_timestamp: "2026-11-09T00:00:00Z" }, dao: DAO,
    holdings: [{ token_id: USDC, symbol: "USDC (test)", decimals: 6, balance: "20000000", open_transfers: [], available: "20000000", error: null }],
    opportunities: [{ id: `rhea-lend:${USDC}:supply`, protocol: "rhea-lend", network, token_id: USDC, symbol: "USDC (test)", apr: 0.05, apy_reward: null, tvl_usd: null, liquidity_usd: null, price_usd: null, sources: [], executable: true, test_data: network === "testnet", warnings: [] }],
    rejected: [], suggestions: [], notes: [], errors: [], limitations: [],
  };
  const kind = supplyProposal("testnet", USDC, "1000000", "20000000").proposal.kind as Record<string, unknown>;
  const proposals = [{ id: 7, proposer: "alice.testnet", description: `${YIELD_PREFIX} supply 1 USDC (test) to Rhea Lend`, status: "InProgress", kind, approvals: 0, submission_time: null }];
  return { report, policy: null, registered: true, positions: [], pools: null, proposals, ...over };
}

const view = (over: Partial<CreateView> = {}): CreateView => ({
  network: "testnet", step: 1, funds: { kind: "ready", rows: [{ dao: DAO, total: "20000000", idle: "20000000", failed: false }, { dao: "empty.sputnikv2.testnet", total: "5000000", idle: "0", failed: false }] },
  dao: DAO, idle: "20000000", rate: { apr: 0.05, testData: true }, token: { symbol: "USDC (test)", decimals: 6 },
  values: { maxPut: "10", keepReady: "2", minApr: "3" }, every: "1h", errors: {}, notice: null, ...over,
});

describe("saved settings", () => {
  // A hand-edited or old localStorage value must never be half-trusted: limits steer what the page suggests.
  it("rejects malformed and negative values", () => {
    assert.deepEqual(parseSettings(S), S);
    for (const bad of [null, "x", {}, { ...S, maxPut: "-1" }, { ...S, keepReady: "1.5" }, { ...S, minApr: -0.1 }, { ...S, minApr: 2 }, { ...S, minApr: "0.03" }, { ...S, checkEvery: "5m" }, { ...S, mode: "auto" }, { ...S, paused: "no" }]) {
      assert.equal(parseSettings(bad), null);
    }
  });

  // The limit cannot exceed what the treasury holds, or "up to X" would promise money that is not there.
  it("rejects a limit above what is idle and bad text", () => {
    const over = validateSettings({ maxPut: "20.000001", keepReady: "0", minApr: "3" }, ctx);
    assert.equal(over.ok, false);
    assert.ok(!over.ok && over.errors.maxPut);
    const bad = validateSettings({ maxPut: "0", keepReady: "-1", minApr: "abc" }, ctx);
    assert.ok(!bad.ok && bad.errors.maxPut && bad.errors.keepReady && bad.errors.minApr);
    assert.deepEqual(validateSettings({ maxPut: "10", keepReady: "", minApr: "4.5" }, ctx), { ok: true, maxPut: "10000000", keepReady: "0", minApr: 0.045 });
  });
});

describe("what the agent suggests", () => {
  it("is capped by keep-ready and by the put-to-work limit, never below 0", () => {
    assert.equal(suggestedAmount(20n, 0n, { maxPut: 100n, keepReady: 5n }), 15n, "keepReady binds");
    assert.equal(suggestedAmount(20n, 8n, { maxPut: 10n, keepReady: 0n }), 2n, "maxPut minus supplied binds");
    assert.equal(suggestedAmount(3n, 0n, { maxPut: 100n, keepReady: 5n }), 0n);
    assert.equal(suggestedAmount(20n, 50n, { maxPut: 10n, keepReady: 0n }), 0n);
  });

  it("proposes the capped amount, register first", () => {
    assert.deepEqual(suggest(base()), { kind: "supply", amount: "10000000" });
    assert.deepEqual(suggest(base({ registered: false })), { kind: "register", amount: "10000000" });
  });

  // The card must say which limit stopped it, so the owner knows what to change.
  it("names the reason when there is nothing to do", () => {
    const why = (o: Partial<SuggestInput>) => { const s = suggest(base(o)); assert.equal(s.kind, "nothing"); return s.kind === "nothing" ? s.reason : ""; };
    assert.match(why({ settings: { ...S, paused: true } }), /paused/);
    assert.match(why({ apr: 0.02 }), /below your floor \(2% < 3%\)/);
    assert.match(why({ idle: "1500000" }), /beyond what you keep ready/);
    assert.match(why({ supplied: "10000000" }), /limit on what to put to work is reached/);
  });

  it("works without settings: everything idle", () => {
    assert.deepEqual(suggest(base({ settings: null, supplied: null })), { kind: "supply", amount: "20000000" });
  });

  it("states the exact limits in the review sentence", () => {
    const t = reviewSentence(S, 6, "USDC (test)");
    for (const part of ["every hour", "up to 10 USDC (test)", "keeping 2 USDC (test) ready", "above 3% a year", "You approve every move"]) assert.ok(t.includes(part), part);
  });
});

describe("New yield agent (K7)", () => {
  it("parses new=1 and builds its link", () => {
    assert.equal(parseRoute(yieldNewHref()).yieldNew, true);
    assert.equal(parseRoute("?page=yield").yieldNew, false);
    assert.equal(parseRoute("?page=yield&dao=a.testnet&new=1").yieldNew, true);
  });

  // Creating an agent saves limits in the browser. Nothing here is a signature.
  it("never offers a signing action on any step", () => {
    for (let step = 1; step <= 5; step++) assert.doesNotMatch(renderYieldCreate(view({ step })).value, /yield-sign|data-action="yield-vote"/);
  });

  it("disables Move on its own and says why", () => {
    const h = renderYieldCreate(view({ step: 4 })).value;
    assert.match(h, /Move on its own/);
    assert.match(h, /No spending limit for tokens exists on chain yet, so every move needs a council vote/);
    assert.match(h, /aria-disabled="true"/);
    assert.match(h, /aria-pressed="true"[^>]*>[\s\S]*?Suggest, I approve each move/);
  });

  it("disables a treasury with nothing idle and shows the reason", () => {
    const h = renderYieldCreate(view()).value;
    assert.match(h, /Nothing idle to put to work/);
    assert.equal((h.match(/data-action="yield-new-pick"/g) ?? []).length, 1);
  });

  it("shows the exact limits on Review", () => {
    assert.ok(renderYieldCreate(view({ step: 5 })).value.includes("up to 10 USDC (test)"));
  });

  it("marks the current step and lists later options as Later", () => {
    const h = renderYieldCreate(view({ step: 2 })).value;
    assert.match(h, /aria-current="step"/);
    assert.match(h, /Auto-stake[\s\S]*Later/);
  });

  it("replaces the form with the testnet line on mainnet", () => {
    const h = renderYieldCreate(view({ network: "mainnet" })).value;
    assert.match(h, /testnet only for now/);
    assert.doesNotMatch(h, /<form/);
  });

  // The words test (README Words table): a newcomer never sees the council's internals.
  it("uses plain words on every step", () => {
    for (let step = 1; step <= 5; step++) assert.doesNotMatch(words(renderYieldCreate(view({ step })).value), JARGON, `step ${step}`);
    assert.doesNotMatch(words(renderYieldCreate(view({ funds: { kind: "signed-out" } })).value), JARGON);
  });
});

describe("Yield agent (K8)", () => {
  it("uses plain words with and without limits, and in the Edit limits drawer", () => {
    assert.doesNotMatch(words(renderYield(live(), "testnet", S).value), JARGON);
    assert.doesNotMatch(words(renderYield(live(), "testnet", null).value), JARGON);
    const drawer = renderYieldLimits(live(), "testnet", S, null, {});
    assert.ok(drawer !== null);
    assert.doesNotMatch(words(drawer.value), JARGON);
  });

  it("lets a treasury with nothing idle still set limits: the drawer asks for no impossible 'at most 0'", () => {
    // K8 saves with no balance ceiling, so a limit above today's idle is valid; suggestions are still capped by idle.
    const empty = live("testnet", { report: { ...live().report, holdings: [{ ...live().report.holdings[0]!, balance: "0", available: "0" }] } });
    const drawer = renderYieldLimits(empty, "testnet", null, null, {});
    assert.ok(drawer !== null);
    assert.doesNotMatch(drawer.value, /At most 0/);
    assert.match(drawer.value, /name="maxPut"[^>]*value=""/);
    assert.equal(validateSettings({ maxPut: "5", keepReady: "0", minApr: "4" }, { ...ctx, ceiling: null }).ok, true);
  });

  it("prompts for limits when none are saved", () => {
    assert.match(renderYield(live(), "testnet", null).value, /data-action="yield-limits-open"/);
  });

  it("shows the nothing-to-do reason from the settings, and no Earned so far", () => {
    // An open vote is featured first, so the reason shows when none is open.
    const h = renderYield(live("testnet", { proposals: [] }), "testnet", { ...S, paused: true }).value;
    assert.match(h, /Nothing to do/);
    assert.match(h, /paused/);
    assert.doesNotMatch(h, /Earned so far/);
  });

  it("replaces the actions with the testnet line on mainnet", () => {
    const h = renderYield(live("mainnet"), "mainnet", S).value;
    assert.match(h, /Yield works on testnet only for now/);
    assert.doesNotMatch(h, /data-action="yield-(vote|pause|limits-open)"/);
  });
});
