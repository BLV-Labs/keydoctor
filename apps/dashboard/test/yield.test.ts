import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KdYieldReport, YieldOpportunity } from "key-doctor";
import type { RawPolicy } from "../src/guard-proposals.ts";
import { allowedYieldKind, checkYieldCall, registerProposal, supplyProposal, tokenAmount, tokenRaw, withdrawAllProposal, YIELD_ALLOWLIST, YIELD_PREFIX, YieldProposalError } from "../src/yield-proposals.ts";
import { councilAccounts, isYieldProposal, parsePositions, type YieldLive } from "../src/yield-read.ts";
import { renderYield, tileAmount, yieldActions, yieldState } from "../src/yield-view.ts";

const LEND = "contract.1638481328.burrow.testnet";
const USDC = "usdc.fakes.testnet";
const DAO = "demo.sputnikv2.testnet";

type Action = { method_name: string; args: string; deposit: string; gas: string };
const call = (p: ReturnType<typeof registerProposal>) => {
  const fc = (p.proposal.kind as { FunctionCall: { receiver_id: string; actions: Action[] } }).FunctionCall;
  const a = fc.actions[0]!;
  return { receiver: fc.receiver_id, method: a.method_name, deposit: a.deposit, args: JSON.parse(Buffer.from(a.args, "base64").toString()) as Record<string, unknown> };
};
const SUPPLY_KIND = supplyProposal("testnet", USDC, "1000000", "20000000").proposal.kind as Record<string, unknown>;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const fcKind = (receiver: string, method: string, args: unknown, deposit = "1") => ({
  FunctionCall: { receiver_id: receiver, actions: [{ method_name: method, args: b64(args), deposit, gas: "150000000000000" }] },
});
const problem = (code: string) => (e: unknown) => e instanceof YieldProposalError && e.code === code;

describe("yield proposal builder", () => {
  // Funds may only go where the YD0 spike proved a supply and a withdraw work. A typo here moves DAO money elsewhere.
  it("rejects any receiver or method off the allowlist", () => {
    assert.throws(() => checkYieldCall("testnet", "evil.testnet", "ft_transfer_call", { receiver_id: LEND }), problem("OFF_ALLOWLIST"));
    assert.throws(() => checkYieldCall("testnet", LEND, "withdraw_all_to", {}), problem("OFF_ALLOWLIST"));
    // An allowlisted token sent anywhere but Rhea Lend is a plain transfer out of the treasury.
    assert.throws(() => checkYieldCall("testnet", USDC, "ft_transfer_call", { receiver_id: "evil.testnet" }), problem("OFF_ALLOWLIST"));
    assert.throws(() => supplyProposal("testnet", "other.fakes.testnet", "1", "10"), problem("OFF_ALLOWLIST"));
    assert.doesNotThrow(() => checkYieldCall("testnet", USDC, "ft_transfer_call", { receiver_id: LEND }));
  });

  it("stays off on mainnet until YD4b", () => {
    assert.equal(YIELD_ALLOWLIST.mainnet, null);
    assert.throws(() => registerProposal("mainnet"), problem("NETWORK_OFF"));
    assert.throws(() => withdrawAllProposal("mainnet", USDC), problem("NETWORK_OFF"));
  });

  it("builds the spike's supply: ft_transfer_call to Rhea Lend, 1 yocto, no collateral msg", () => {
    const p = supplyProposal("testnet", USDC, "12500000", "20000000");
    assert.ok(p.proposal.description.startsWith(YIELD_PREFIX));
    assert.match(p.proposal.description, /12\.5 USDC/);
    assert.deepEqual(call(p), { receiver: USDC, method: "ft_transfer_call", deposit: "1", args: { receiver_id: LEND, amount: "12500000", msg: "" } });
  });

  // A supply over what the DAO holds outside open transfers would fail on chain or race a payout the council approved.
  it("refuses an amount above the available balance or not above 0", () => {
    assert.throws(() => supplyProposal("testnet", USDC, "20000001", "20000000"), problem("OVER_AVAILABLE"));
    assert.throws(() => supplyProposal("testnet", USDC, "0", "20000000"), problem("BAD_AMOUNT"));
    assert.throws(() => supplyProposal("testnet", USDC, "01", "20000000"), problem("BAD_AMOUNT"));
  });

  it("builds register and withdraw-all on the lend contract", () => {
    assert.deepEqual(call(registerProposal("testnet")), { receiver: LEND, method: "storage_deposit", deposit: "100000000000000000000000", args: {} });
    assert.deepEqual(call(withdrawAllProposal("testnet", USDC)), { receiver: LEND, method: "execute", deposit: "1", args: { actions: [{ Withdraw: { token_id: USDC } }] } });
  });
});

describe("token amounts", () => {
  it("round-trips without float error", () => {
    assert.equal(tokenRaw("12.5", 6), "12500000");
    assert.equal(tokenRaw(" 0.000001 ", 6), "1");
    assert.equal(tokenRaw("7", 6), "7000000");
    assert.equal(tokenAmount("12500000", 6), "12.5");
    assert.equal(tokenAmount("7000000", 6), "7");
    assert.equal(tokenAmount("x", 6), "unknown");
  });
  it("rejects too many decimals, signs and junk", () => {
    for (const bad of ["1.0000001", "-1", "1e6", "", "1,5", ".5"]) assert.equal(tokenRaw(bad, 6), null, bad);
  });
  it("tile amounts round down and group digits so a long balance fits a phone tile", () => {
    // 2,000,046.513634 USDC: the exact form is 14 digits and overflowed a 375px tile.
    assert.equal(tileAmount("2000046513634", 6), "2,000,046.51");
    // Round down, never up: a tile must not show more than the treasury holds.
    assert.equal(tileAmount("999999", 6), "0.99");
    assert.equal(tileAmount("12500000", 6), "12.50");
    assert.equal(tileAmount("0", 6), "0.00");
    // Dust is not shown as zero, which would read as an empty balance.
    assert.equal(tileAmount("9999", 6), "less than 0.01");
    assert.equal(tileAmount("x", 6), "unknown");
  });
});

describe("yield reads", () => {
  it("drops Rhea's extra decimals and ignores tokens off the allowlist", () => {
    const raw = { supplied: [{ token_id: USDC, balance: "12500000000000000000" }, { token_id: "wrap.testnet", balance: "5" }] };
    assert.deepEqual(parsePositions(raw, [USDC], new Map([[USDC, 12]])), [{ token_id: USDC, supplied: "12500000" }]);
    assert.deepEqual(parsePositions(null, [USDC], new Map([[USDC, 12]])), []);
    // An unreadable balance is unknown, not zero: zero would say "Idle" for a DAO that is farming.
    assert.equal(parsePositions({ supplied: [{ token_id: USDC, balance: "?" }] }, [USDC], new Map([[USDC, 12]])), null);
  });

  it("finds yield proposals by prefix or by an allowlisted receiver", () => {
    assert.equal(isYieldProposal("testnet", `${YIELD_PREFIX} supply`, {}), true);
    assert.equal(isYieldProposal("testnet", "pay", { FunctionCall: { receiver_id: LEND } }), true);
    assert.equal(isYieldProposal("testnet", "pay", { Transfer: { receiver_id: "bob.testnet" } }), false);
  });

  // The Guard's role holds the Guard contract, not people: it must not make a DAO show up as "yours".
  it("counts council members from Group roles, not the agent-guard role", () => {
    const policy = {
      roles: [
        { name: "council", kind: { Group: ["alice.testnet"] }, permissions: [], vote_policy: {} },
        { name: "agent-guard", kind: { Group: ["bob.testnet"] }, permissions: [], vote_policy: {} },
        { name: "all", kind: "Everyone", permissions: [], vote_policy: {} },
      ],
      proposal_bond: "1",
    } as unknown as RawPolicy;
    assert.deepEqual(councilAccounts(policy, ["bob.testnet", "alice.testnet", "carol.testnet"]), ["alice.testnet"]);
  });
});

function opportunity(network: "testnet" | "mainnet"): YieldOpportunity {
  return {
    id: `rhea-lend:${USDC}:supply`, protocol: "rhea-lend", network, token_id: USDC, symbol: "USDC (test)", apr: 0.05,
    apy_reward: null, tvl_usd: null, liquidity_usd: null, price_usd: null, sources: [], executable: true, test_data: network === "testnet", warnings: [],
  };
}

function live(network: "testnet" | "mainnet", over: Partial<YieldLive> = {}): YieldLive {
  const report: KdYieldReport = {
    schema_version: "kd.yield.v1", yield_ruleset_version: "y1", generated_at: "2026-11-09T00:00:00Z",
    chain: { network, block_height: 1, block_timestamp: "2026-11-09T00:00:00Z" }, dao: DAO,
    holdings: [{ token_id: USDC, symbol: "USDC (test)", decimals: 6, balance: "20000000", open_transfers: [], available: "20000000", error: null }],
    opportunities: [opportunity(network)], rejected: [], suggestions: [{ opportunity_id: `rhea-lend:${USDC}:supply`, token_id: USDC, max_amount: "20000000" }],
    notes: [], errors: [], limitations: [],
  };
  const proposals = [{ id: 7, proposer: "alice.testnet", description: `${YIELD_PREFIX} supply 1 USDC (test) to Rhea Lend`, status: "InProgress", kind: SUPPLY_KIND, approvals: 0, submission_time: null }];
  return { report, policy: null, registered: true, positions: [], pools: null, proposals, ...over };
}

// Anyone can add a proposal whose description says "[KD-YIELD] supply". Only its kind says where funds go, so the
// page offers a vote only on the exact calls it builds.
describe("allowedYieldKind", () => {
  it("accepts the three calls the builder makes", () => {
    for (const p of [registerProposal("testnet"), supplyProposal("testnet", USDC, "5", "5"), withdrawAllProposal("testnet", USDC)]) {
      assert.equal(allowedYieldKind("testnet", p.proposal.kind as Record<string, unknown>), true);
    }
  });

  it("rejects calls that would move funds anywhere else", () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["a transfer", { Transfer: { token_id: "", receiver_id: "bob.testnet", amount: "1" } }],
      ["a supply to another receiver", fcKind(USDC, "ft_transfer_call", { receiver_id: "bob.testnet", amount: "5", msg: "" })],
      ["a supply with a msg", fcKind(USDC, "ft_transfer_call", { receiver_id: LEND, amount: "5", msg: "{\"Execute\":{}}" })],
      ["an off-list token", fcKind("other.testnet", "ft_transfer_call", { receiver_id: LEND, amount: "5", msg: "" })],
      ["a plain ft_transfer", fcKind(USDC, "ft_transfer", { receiver_id: "bob.testnet", amount: "5" })],
      ["a big storage deposit", fcKind(LEND, "storage_deposit", {}, "1000000000000000000000000000")],
      ["a storage deposit for someone else", fcKind(LEND, "storage_deposit", { account_id: "bob.testnet" }, "100000000000000000000000")],
      ["a borrow", fcKind(LEND, "execute", { actions: [{ Borrow: { token_id: USDC, amount: "5" } }] })],
      ["a withdraw plus more", fcKind(LEND, "execute", { actions: [{ Withdraw: { token_id: USDC } }, { Borrow: { token_id: USDC } }] })],
      ["undecodable args", { FunctionCall: { receiver_id: LEND, actions: [{ method_name: "execute", args: "%%%", deposit: "1", gas: "1" }] } }],
    ];
    for (const [why, kind] of bad) assert.equal(allowedYieldKind("testnet", kind), false, why);
    assert.equal(allowedYieldKind("mainnet", SUPPLY_KIND), false, "mainnet is off");
  });

  it("shows no vote on a prefixed proposal that pays someone else, and names its real call", () => {
    const hostile = { id: 9, proposer: "mallory.testnet", description: `${YIELD_PREFIX} supply 1 USDC (test) to Rhea Lend`, status: "InProgress", kind: { Transfer: { receiver_id: "mallory.testnet" } }, approvals: 0, submission_time: null };
    const page = renderYield(live("testnet", { policy: null, proposals: [hostile] }), "testnet").value;
    assert.doesNotMatch(page, /data-action="yield-vote"/);
    assert.match(page, /Not a move this page builds \(Transfer\)/);
    assert.match(renderYield(live("testnet"), "testnet").value, /data-action="yield-vote" data-id="7"/);
  });
});

describe("yield page", () => {
  it("labels testnet rates as test data", () => {
    assert.match(renderYield(live("testnet"), "testnet").value, /Test data/);
  });

  // Mainnet waits for YD4b: the page may show rates but must offer nothing to sign.
  it("offers no enabled action and no vote on mainnet", () => {
    const page = renderYield(live("mainnet"), "mainnet").value;
    assert.match(page, /testnet only for now/);
    assert.doesNotMatch(page, /data-action="yield-vote"/);
    for (const b of page.match(/<button[^>]*data-action="yield-open"[^>]*>/g) ?? []) assert.match(b, / disabled/);
  });

  it("asks for registration before a supply", () => {
    const can = yieldActions(live("testnet", { registered: false }), "testnet");
    assert.equal(can.register, true);
    assert.equal(can.supply, false);
    assert.equal(yieldActions(live("testnet"), "testnet").supply, true);
  });

  it("calls a DAO farming only when something is supplied, unknown when unread", () => {
    assert.equal(yieldState([{ token_id: USDC, supplied: "1" }]), "farming");
    assert.equal(yieldState([]), "idle");
    assert.equal(yieldState(null), "unknown");
  });
});
