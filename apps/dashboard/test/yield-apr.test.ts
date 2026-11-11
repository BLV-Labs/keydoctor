import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KdYieldReport, RheaPool } from "key-doctor";
import { suggest } from "../src/yield-agent.ts";
import { allowedYieldKind, describeYieldKind, withdrawAllProposal, withdrawProposal, YieldProposalError } from "../src/yield-proposals.ts";
import type { RawPolicy } from "../src/guard-proposals.ts";
import type { YieldLive } from "../src/yield-read.ts";
import { renderYieldPanel, yieldPreview } from "../src/yield-view.ts";

const LEND = "contract.1638481328.burrow.testnet";
const USDC = "usdc.fakes.testnet";
const DAO = "demo.sputnikv2.testnet";
const U = 10n ** 6n;
/** The testnet demo DAO's supply after the Y3 deposits: 1,800,020.040558 USDC. */
const OWN = 1_800_020_040_558n;

// Testnet USDC pool from get_asset at block 276952485 (the key-doctor rate-model fixture), with the DAO's supply in it.
const POOL: RheaPool = {
  token_id: USDC,
  extra_decimals: 12,
  supplied: "2268608145769611982528993",
  borrowed: "446710855933659922323654",
  reserved: "82680843798871841113983",
  target_utilization: 8000,
  reserve_ratio: 2500,
  target_utilization_rate: "1000000000002440418605283556",
  max_utilization_rate: "1000000000039724853136740579",
};
/** The same pool before the DAO put anything in: the state the suggestion card saw. */
const BEFORE: RheaPool = { ...POOL, supplied: (BigInt(POOL.supplied) - OWN * 10n ** 12n).toString() };

type Action = { method_name: string; args: string };
const args = (p: ReturnType<typeof withdrawAllProposal>) => {
  const a = (p.proposal.kind as { FunctionCall: { receiver_id: string; actions: Action[] } }).FunctionCall;
  return { receiver: a.receiver_id, method: a.actions[0]!.method_name, args: JSON.parse(Buffer.from(a.actions[0]!.args, "base64").toString()) as unknown };
};
const problem = (code: string) => (e: unknown) => e instanceof YieldProposalError && e.code === code;
const kindOf = (p: ReturnType<typeof withdrawAllProposal>) => p.proposal.kind as Record<string, unknown>;

function live(over: Partial<YieldLive> & { idle?: string } = {}): YieldLive {
  const idle = over.idle ?? (200_000n * U).toString();
  const report: KdYieldReport = {
    schema_version: "kd.yield.v1", yield_ruleset_version: "y1", generated_at: "2026-11-10T00:00:00Z",
    chain: { network: "testnet", block_height: 1, block_timestamp: "2026-11-10T00:00:00Z" }, dao: DAO,
    holdings: [{ token_id: USDC, symbol: "USDC (test)", decimals: 6, balance: idle, open_transfers: [], available: idle, error: null }],
    opportunities: [{ id: `rhea-lend:${USDC}:supply`, protocol: "rhea-lend", network: "testnet", token_id: USDC, symbol: "USDC (test)", apr: 0.0027, apy_reward: null, tvl_usd: null, liquidity_usd: null, price_usd: null, sources: [], executable: true, test_data: true, warnings: [] }],
    rejected: [], suggestions: [], notes: [], errors: [], limitations: [],
  };
  const policy = { roles: [], default_vote_policy: {}, proposal_bond: "1000000000000000000000000" } as unknown as RawPolicy;
  return { report, policy, registered: true, positions: [{ token_id: USDC, supplied: OWN.toString() }], pools: [POOL], proposals: [], ...over } as YieldLive;
}

// The owner typed 1,800,020.04 into Take it back, thinking it was the amount to withdraw. The drawer now takes an
// amount, so a part can come back while the rest keeps earning.
describe("partial withdraw", () => {
  it("sends the amount in Rhea Lend's inner units (token raw × 10^12): raw units would withdraw a millionth of a millionth", () => {
    const p = withdrawProposal("testnet", USDC, (1_300_020n * U).toString(), OWN.toString());
    assert.deepEqual(args(p), { receiver: LEND, method: "execute", args: { actions: [{ Withdraw: { token_id: USDC, amount: (1_300_020n * U * 10n ** 12n).toString() } }] } });
    assert.match(p.proposal.description, /withdraw 1300020 USDC/);
  });

  it("takes everything back, with no amount, when the field is empty or equals the whole supply: interest still accruing comes too", () => {
    const all = withdrawAllProposal("testnet", USDC);
    assert.deepEqual(withdrawProposal("testnet", USDC, null, OWN.toString()), all);
    assert.deepEqual(withdrawProposal("testnet", USDC, OWN.toString(), OWN.toString()), all);
  });

  it("refuses 0, a leading zero, and more than is on Rhea Lend", () => {
    assert.throws(() => withdrawProposal("testnet", USDC, "0", OWN.toString()), problem("BAD_AMOUNT"));
    assert.throws(() => withdrawProposal("testnet", USDC, "01", OWN.toString()), problem("BAD_AMOUNT"));
    assert.throws(() => withdrawProposal("testnet", USDC, (OWN + 1n).toString(), OWN.toString()), problem("OVER_AVAILABLE"));
  });

  it("the vote check accepts the built partial withdraw and reads its amount back in token units", () => {
    const p = withdrawProposal("testnet", USDC, "2500000", OWN.toString());
    assert.equal(allowedYieldKind("testnet", kindOf(p)), true);
    assert.deepEqual(describeYieldKind("testnet", kindOf(p)), { kind: "withdraw", amount: "2500000" });
    assert.deepEqual(describeYieldKind("testnet", kindOf(withdrawAllProposal("testnet", USDC))), { kind: "withdraw", amount: null });
  });

  it("offers no vote on a Withdraw whose amount is not whole token units or carries extra keys", () => {
    const fc = (w: unknown) => ({ FunctionCall: { receiver_id: LEND, actions: [{ method_name: "execute", args: Buffer.from(JSON.stringify({ actions: [{ Withdraw: w }] })).toString("base64"), deposit: "1", gas: "1" }] } });
    assert.equal(allowedYieldKind("testnet", fc({ token_id: USDC, amount: "2500000" })), false, "raw units, not inner: a 10^-12 dust withdraw");
    assert.equal(allowedYieldKind("testnet", fc({ token_id: USDC, amount: "0" })), false);
    assert.equal(allowedYieldKind("testnet", fc({ token_id: USDC, amount: "2500000000000000000", max_amount: "1" })), false);
  });
});

describe("APR preview and best amount", () => {
  it("the suggestion caps the deposit at the best amount and keeps what all-in would be", () => {
    // 2,000,020 idle into the empty pool: the best amount earns ~7.2k a year against ~4.6k for all of it.
    const s = suggest({ settings: null, apr: 0.1, idle: (2_000_020n * U).toString(), supplied: "0", registered: true, pool: BEFORE, decimals: 6, symbol: "USDC (test)" });
    assert.equal(s.kind, "supply");
    if (s.kind !== "supply") return;
    assert.equal(s.all, (2_000_020n * U).toString());
    assert.ok(BigInt(s.amount) >= 400_000n * U && BigInt(s.amount) <= 600_000n * U, s.amount);
  });

  it("suggests nothing once the treasury is past the best amount: more would earn it less", () => {
    const s = suggest({ settings: null, apr: 0.0027, idle: (200_000n * U).toString(), supplied: OWN.toString(), registered: true, pool: POOL, decimals: 6, symbol: "USDC (test)" });
    assert.equal(s.kind, "nothing");
    assert.match(s.kind === "nothing" ? s.reason : "", /lower what the treasury earns/);
  });

  it("without the pool it suggests all of it, as before", () => {
    const s = suggest({ settings: null, apr: 0.1, idle: "5000000", supplied: "0", registered: true, pool: null, decimals: 6, symbol: "USDC (test)" });
    assert.deepEqual(s, { kind: "supply", amount: "5000000" });
  });

  it("the preview shows the rate rising after a partial withdraw and what the rest would earn", () => {
    const line = yieldPreview("withdraw", live(), "testnet", "1300020");
    assert.match(line, /^Rate 0\.27% → \d+(\.\d+)?% a year\. The treasury's 500,000 USDC \(test\) there would earn about [\d,]+ USDC \(test\) a year/);
    assert.match(yieldPreview("withdraw", live(), "testnet", ""), /Nothing of the treasury's stays on Rhea Lend/);
    assert.equal(yieldPreview("withdraw", live(), "testnet", "9999999"), "", "more than supplied shows nothing rather than a wrong number");
    assert.equal(yieldPreview("supply", live(), "testnet", "abc"), "");
    assert.equal(yieldPreview("supply", live({ pools: null }), "testnet", "10"), "", "no pool, no projection");
  });

  it("the supply drawer offers a Best chip below Max and says why", () => {
    const empty = live({ positions: [], pools: [BEFORE], idle: (2_000_020n * U).toString() });
    const page = renderYieldPanel("supply", empty, "testnet")!.value;
    // The chip reads grouped, but data-amount stays plain: it is copied into the input, which tokenRaw parses without commas.
    assert.match(page, /data-action="yield-max" data-amount="4\d0000">Best 4\d0,000</);
    assert.match(page, /data-amount="2000020">Max 2,000,020</);
    assert.match(page, /Best earns the treasury the most a year/);
  });
});

describe("drawer wording", () => {
  it("Take money back is a form with an amount, an All chip and the supplied amount", () => {
    const page = renderYieldPanel("withdraw", live(), "testnet")!.value;
    assert.match(page, /<form id="yield-panel-form"[^>]*data-panel="withdraw"/);
    assert.match(page, /id="yp-amount"/);
    assert.match(page, /data-amount="1800020\.040558">All 1,800,020\.040558/);
    assert.match(page, /Leave it empty to take everything back/);
  });

  it("names the 1 NEAR as the treasury's proposal bond, returned after the vote, not a fee", () => {
    for (const panel of ["register", "supply", "withdraw"] as const) {
      const page = renderYieldPanel(panel, live(), "testnet")!.value;
      assert.match(page, /Proposal bond \(returned\)/, panel);
      assert.match(page, /holds 1 NEAR from your wallet as its proposal bond and returns it when the vote passes or is rejected/, panel);
    }
  });
});
