import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { DCA_TESTNET } from "key-doctor";
import { createDcaProposal, dcaFloorFromText, dcaFloorPrefill, dcaFromForm, DCA_SLIPPAGE_CHOICES } from "../src/budget-flow.ts";
import { DCA_TOKEN_CONTRACTS, guardNeedsUpdate, readDcaQuote, readDcaReadiness } from "../src/budget-read.ts";
import type { BudgetLive, BudgetPlan, DcaReadiness } from "../src/budget-read.ts";
import { renderBudget, renderBudgetCreate, renderBudgetPanel, type DcaView } from "../src/budget-view.ts";
import { html } from "../src/html.ts";
import {
  addGuardRoleProposal,
  allowSwapsProposal,
  BUDGET_GUARD_PERMISSIONS,
  enableUsdtProposals,
  GUARD_PERMISSIONS,
  hasSwapRights,
  upgradeGuardProposal,
  type RawPolicy,
} from "../src/guard-proposals.ts";
import { parseRoute } from "../src/route.ts";

const NEAR = (n: number) => `${n}${"0".repeat(24)}`;
const GUARD = "g1.guards.testnet";
const DAO = "team.sputnik-v2.testnet";
const FACTORY = "guards.testnet";
const decode = (b64: string) => JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
const action = (a: { proposal: { kind: unknown } }) => (a.proposal.kind as { FunctionCall: { receiver_id: string; actions: Record<string, string>[] } }).FunctionCall;

const owner = { name: "council", kind: { Group: ["owner.testnet"] }, permissions: ["*:*"], vote_policy: {} };
const policyWith = (guardRole: Record<string, unknown> | null): RawPolicy => ({
  proposal_bond: "100000000000000000000000",
  roles: (guardRole === null ? [owner] : [owner, guardRole]) as RawPolicy["roles"],
});
const oldRole = { name: "agent-guard", kind: { Group: [GUARD] }, permissions: [...GUARD_PERMISSIONS], vote_policy: { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: "1" } } };

describe("guard-proposals: swap rights", () => {
  it("a new Budget's role carries the swap rights and a vote rule for call, or its swaps could never be approved", () => {
    const args = addGuardRoleProposal(policyWith(null), GUARD, BUDGET_GUARD_PERMISSIONS)!;
    const role = (args.proposal.kind as { ChangePolicy: { policy: RawPolicy } }).ChangePolicy.policy.roles.find((r) => r.name === "agent-guard")!;
    assert.ok(role.permissions.includes("call:AddProposal") && role.permissions.includes("call:VoteApprove"));
    assert.deepEqual(Object.keys(role.vote_policy).sort(), ["call", "transfer"]);
  });
  it("the default (no rights argument) stays transfer-only, so old call sites do not silently gain swaps", () => {
    const role = (addGuardRoleProposal(policyWith(null), GUARD)!.proposal.kind as { ChangePolicy: { policy: RawPolicy } }).ChangePolicy.policy.roles.find((r) => r.name === "agent-guard")!;
    assert.equal(role.permissions.includes("call:AddProposal"), false);
    assert.deepEqual(Object.keys(role.vote_policy), ["transfer"]);
  });
  it("allowSwapsProposal adds the rights to the role that lists the Guard and leaves other roles and members alone", () => {
    const other = { name: "agent-guard-2", kind: { Group: ["other.guards.testnet"] }, permissions: ["transfer:AddProposal"], vote_policy: {} };
    const policy = { ...policyWith(oldRole), roles: [owner, oldRole, other] } as RawPolicy;
    const args = allowSwapsProposal(policy, GUARD)!;
    const roles = (args.proposal.kind as { ChangePolicy: { policy: RawPolicy } }).ChangePolicy.policy.roles;
    assert.deepEqual(roles[0]!, owner);
    assert.deepEqual(roles[2]!, other, "a decoy role with no Guard must not gain rights");
    assert.deepEqual(roles[1]!.kind, { Group: [GUARD] });
    for (const p of [...GUARD_PERMISSIONS, "call:AddProposal", "call:VoteApprove"]) assert.ok(roles[1]!.permissions.includes(p), p);
    assert.ok("call" in roles[1]!.vote_policy && "transfer" in roles[1]!.vote_policy);
    assert.equal(hasSwapRights({ ...policy, roles }, GUARD), true);
  });
  it("allowSwapsProposal keeps an existing vote rule for call instead of overriding it", () => {
    const custom = { weight_kind: "RoleWeight", quorum: "0", threshold: "2" };
    const role = { ...oldRole, vote_policy: { call: custom } };
    const roles = (allowSwapsProposal(policyWith(role), GUARD)!.proposal.kind as { ChangePolicy: { policy: RawPolicy } }).ChangePolicy.policy.roles;
    assert.deepEqual(roles[1]!.vote_policy.call, custom);
  });
  it("allowSwapsProposal is null when the rights exist or no role lists the Guard", () => {
    const full = { ...oldRole, permissions: BUDGET_GUARD_PERMISSIONS };
    assert.equal(allowSwapsProposal(policyWith(full), GUARD), null);
    assert.equal(allowSwapsProposal(policyWith(null), GUARD), null);
    assert.equal(allowSwapsProposal(policyWith({ ...oldRole, kind: { Group: ["x.guards.testnet"] } }), GUARD), null);
  });
  it("hasSwapRights needs both rights, not one", () => {
    assert.equal(hasSwapRights(policyWith({ ...oldRole, permissions: [...GUARD_PERMISSIONS, "call:AddProposal"] }), GUARD), false);
  });
});

describe("guard-proposals: Update your Budget", () => {
  it("calls upgrade on the Guard with the factory as code source and the hash passed through untouched, within the 300 Tgas an act_proposal carries", () => {
    const fc = action(upgradeGuardProposal(GUARD, FACTORY, "5Hq3HashFromFactory"));
    assert.equal(fc.receiver_id, GUARD);
    assert.equal(fc.actions.length, 1);
    assert.equal(fc.actions[0]!.method_name, "upgrade");
    assert.deepEqual(decode(fc.actions[0]!.args!), { code_source: FACTORY, code_hash: "5Hq3HashFromFactory" });
    assert.equal(fc.actions[0]!.gas, "200000000000000");
  });
});

describe("guard-proposals: Enable USDT", () => {
  const reg = (contract: string, min = "1250000000000000000000") => ({ contract, min });
  it("makes one storage_deposit per missing contract, paying that contract's own minimum for the DAO", () => {
    const out = enableUsdtProposals(DAO, [reg("wrap.testnet", "1"), reg("usdt.fakes.testnet", "2")]);
    assert.equal(out.length, 2);
    const [a, b] = out.map(action) as [ReturnType<typeof action>, ReturnType<typeof action>];
    assert.equal(a.receiver_id, "wrap.testnet");
    assert.equal(a.actions[0]!.deposit, "1");
    assert.equal(b.receiver_id, "usdt.fakes.testnet");
    assert.equal(b.actions[0]!.deposit, "2");
    assert.equal(a.actions[0]!.method_name, "storage_deposit");
    assert.deepEqual(decode(a.actions[0]!.args!), { account_id: DAO, registration_only: true });
  });
  it("makes none when every contract already has the DAO", () => {
    assert.deepEqual(enableUsdtProposals(DAO, []), []);
  });
});

describe("budget-read: guardNeedsUpdate", () => {
  it("is true below 1.5.0 and false from 1.5.0 up: a 1.4.0 Guard has no lowest price, so a DCA must not start on it", () => {
    for (const v of ["0.9.9", "1.0.0", "1.2.0", "1.3.0", "1.4.0", "1.4.99"]) assert.equal(guardNeedsUpdate(v), true, v);
    for (const v of ["1.5.0", "1.5.1", "1.10.0", "2.0.0", "2.0.1"]) assert.equal(guardNeedsUpdate(v), false, v);
  });
  it("treats an unreadable version as not old, so no Update button shows on a guess", () => {
    for (const v of [null, "", "abc", "1.2", "v1.2.0", "1.2.0-beta"]) assert.equal(guardNeedsUpdate(v), false, String(v));
  });
});

type Views = Record<string, unknown>;
function stubRpc(views: Views): string[] {
  const calls: string[] = [];
  const encode = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
  mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
    if (method === "block") return Response.json({ jsonrpc: "2.0", id: "kd", result: { header: { height: 99, timestamp_nanosec: "1" } } });
    const key = `${params.account_id}.${params.method_name}`;
    calls.push(key);
    if (!(key in views)) return Response.json({ jsonrpc: "2.0", id: "kd", error: { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR" } } });
    return Response.json({ jsonrpc: "2.0", id: "kd", result: { result: encode(views[key]), logs: [], block_height: 99 } });
  });
  return calls;
}
afterEach(() => mock.restoreAll());

describe("budget-read: readDcaReadiness and readDcaQuote", () => {
  const MIN = "1250000000000000000000";
  const regViews = (registered: Record<string, boolean>): Views => {
    const v: Views = {};
    for (const c of DCA_TOKEN_CONTRACTS) {
      v[`${c}.storage_balance_bounds`] = { min: MIN, max: null };
      v[`${c}.storage_balance_of`] = registered[c] ? { total: MIN, available: "0" } : null;
    }
    return v;
  };
  it("reads the Guard version, the factory hash and which contracts lack the DAO", async () => {
    stubRpc({ [`${GUARD}.kd_guard_info`]: { version: "1.2.0" }, [`${FACTORY}.get_code_hash`]: "HASH", ...regViews({ [DCA_TESTNET.wrap]: true }) });
    const r = await readDcaReadiness(DAO, GUARD, FACTORY, "testnet");
    assert.equal(r.version, "1.2.0");
    assert.equal(r.latestHash, "HASH");
    assert.deepEqual(r.registrations!.filter((x) => !x.registered).map((x) => x.contract).sort(), [DCA_TESTNET.exchange, DCA_TESTNET.token_out].sort());
    assert.ok(r.registrations!.every((x) => x.min === MIN));
  });
  it("an old Guard with no kd_guard_info gives version null, not a crash", async () => {
    stubRpc({ ...regViews({}) });
    const r = await readDcaReadiness(DAO, GUARD, FACTORY, "testnet");
    assert.equal(r.version, null);
    assert.equal(r.latestHash, null);
  });
  it("one unreadable contract makes the whole registration list null, never a partial 'all enabled'", async () => {
    const v = regViews({ [DCA_TESTNET.wrap]: true, [DCA_TESTNET.exchange]: true, [DCA_TESTNET.token_out]: true });
    delete v[`${DCA_TESTNET.token_out}.storage_balance_bounds`];
    stubRpc({ [`${GUARD}.kd_guard_info`]: { version: "1.3.0" }, ...v });
    assert.equal((await readDcaReadiness(DAO, GUARD, FACTORY, "testnet")).registrations, null);
  });
  it("with no known factory it does not ask for a code hash", async () => {
    const calls = stubRpc({ [`${GUARD}.kd_guard_info`]: { version: "1.3.0" }, ...regViews({}) });
    await readDcaReadiness(DAO, GUARD, "", "testnet");
    assert.ok(!calls.some((c) => c.endsWith("get_code_hash")));
  });
  it("quote: returns the exchange's number for the right pool and tokens, null on bad input or a failed read", async () => {
    const calls = stubRpc({ [`${DCA_TESTNET.exchange}.get_return`]: "896500" });
    assert.equal(await readDcaQuote(NEAR(1), "testnet"), "896500");
    assert.deepEqual(calls, [`${DCA_TESTNET.exchange}.get_return`]);
    assert.equal(await readDcaQuote("0", "testnet"), null);
    assert.equal(await readDcaQuote("1.5", "testnet"), null);
    assert.equal(await readDcaQuote(NEAR(1), "mainnet"), null, "no quote on mainnet");
    mock.restoreAll();
    stubRpc({});
    assert.equal(await readDcaQuote(NEAR(1), "testnet"), null);
  });
});

describe("dcaFromForm", () => {
  const NOW = new Date("2026-11-10T00:00:00").getTime();
  const rules = { policy: { max_per_tx: NEAR(2), max_per_day: NEAR(10) } };
  const form = (over: Record<string, string> = {}) => ({ amount: "1", every: "1", unit: "days", stop: "times", runs: "10", slippage: "100", floor: "0.85", start: "", end: "", ...over });
  const ok = (over: Record<string, string> = {}) => {
    const r = dcaFromForm(form(over), rules, NOW);
    assert.ok(r.ok, r.ok ? "" : r.error);
    return r.value;
  };
  const bad = (over: Record<string, string>, r: { policy: { max_per_tx: string; max_per_day: string } | null } = rules) => {
    const res = dcaFromForm(form(over), r, NOW);
    assert.equal(res.ok, false);
    return res.ok ? "" : res.error;
  };

  it("end date: runs = floor((end - start) / interval) + 1, so a remainder rounds down and the first run counts", () => {
    // 2.5 days after start with a 1-day interval: runs at day 0, 1, 2 -> 3 (a round-up mutant gives 4, a missing +1 gives 2).
    assert.equal(ok({ stop: "date", end: "2026-11-12T12:00" }).runs, 3);
    // End exactly on a run: day 0..2 -> 3.
    assert.equal(ok({ stop: "date", end: "2026-11-12T00:00" }).runs, 3);
    // End equal to start: one run.
    assert.equal(ok({ stop: "date", end: "2026-11-10T00:00" }).runs, 1);
  });
  it("end date counts from the typed start, not from now", () => {
    assert.equal(ok({ stop: "date", start: "2026-11-20T00:00", end: "2026-11-23T06:00" }).runs, 4);
  });
  it("end date before the first run, or past the 1000-run cap, is refused with the reason", () => {
    assert.match(bad({ stop: "date", end: "2026-11-09T00:00" }), /before the first run/);
    assert.match(bad({ stop: "date", unit: "minutes", end: "2026-12-30T00:00" }), /more than the 1000 allowed/);
    assert.match(bad({ stop: "date", end: "" }), /End date/);
  });
  it("a number of times: 1 to 1000 only", () => {
    assert.equal(ok({ runs: "1000" }).runs, 1000);
    for (const r of ["0", "1001", "", "x", "1.5"]) assert.match(bad({ runs: r }), /Number of runs/, r);
  });
  it("slippage is only 50, 100 or 200 bps; anything else is refused, because the Guard accepts 1 to 500 but the page offers three", () => {
    assert.deepEqual([...DCA_SLIPPAGE_CHOICES], [50, 100, 200]);
    for (const s of ["50", "100", "200"]) assert.equal(ok({ slippage: s }).slippage_bps, Number(s));
    for (const s of ["0", "1", "75", "500", "abc"]) assert.match(bad({ slippage: s }), /max price drop/, s);
  });
  it("interval: weeks supported; under 1 minute and over 365 days refused", () => {
    assert.equal(ok({ unit: "weeks", every: "2" }).interval_sec, 1_209_600);
    assert.match(bad({ unit: "minutes", every: "0" }), /1 minute|whole number/);
    assert.match(bad({ unit: "weeks", every: "53" }), /365 days/);
    assert.equal(ok({ unit: "days", every: "365" }).interval_sec, 365 * 86_400);
  });
  it("per-run amount above the per-request or 24-hour limit is refused, as the Guard would refuse it", () => {
    assert.match(bad({ amount: "3" }), /per-request limit/);
    assert.match(bad({ amount: "1.5" }, { policy: { max_per_tx: NEAR(2), max_per_day: NEAR(1) } }), /24-hour limit/);
    assert.match(bad({}, { policy: null }), /Could not read your rules/);
  });
  it("start: empty or past is now; a future start is kept", () => {
    assert.equal(ok().starts_now, true);
    assert.equal(ok({ start: "2020-01-01T00:00" }).start_ms, NOW);
    const later = ok({ start: "2026-11-11T09:30" });
    assert.equal(later.starts_now, false);
    assert.equal(later.start_ms, new Date("2026-11-11T09:30").getTime());
  });
  it("create_plan carries a swap_with_floor action with the typed slippage and lowest price, the exchange's pool and the DCA strategy id, start in nanoseconds", () => {
    const plan = ok({ slippage: "50", floor: "8.5", start: "2026-11-11T09:30" });
    const p = decode(action(createDcaProposal(GUARD, plan)).actions[0]!.args!).plan as Record<string, unknown>;
    // The floor is what bounds a run when someone skews the pool before calling the step (red team H2).
    assert.deepEqual(p.action, { type: "swap_with_floor", pool_id: DCA_TESTNET.pool_id, token_out: DCA_TESTNET.token_out, max_slippage_bps: 50, min_out_per_near: "8500000" });
    assert.equal(p.strategy_id, "dca-near");
    assert.equal(p.amount_per_run, NEAR(1));
    assert.equal(p.start_at, (BigInt(plan.start_ms) * 1_000_000n).toString());
    assert.equal(p.runs_total, 10);
    // Slippage is a bound the Guard checks at the swap; the page must not send a min_out of its own.
    assert.equal("min_out" in p, false);
  });
  it("lowest price: USDT per NEAR to base units with the token's 6 decimals, exact", () => {
    for (const [text, base] of [["8.5", "8500000"], ["0.000001", "1"], ["12", "12000000"], [" 0.851675 ", "851675"], ["1.100000", "1100000"]] as const) {
      const r = dcaFloorFromText(text);
      assert.ok(r.ok && r.value === base, `${text} -> ${r.ok ? r.value : r.error}`);
    }
    assert.equal(ok({ floor: "9.25" }).min_out_per_near, "9250000");
  });
  it("lowest price 0, empty, negative, over 6 decimals or not a number is refused: a zero floor is no floor", () => {
    for (const f of ["0", "0.0", "0.0000001", "1.1234567", "", "-1", "abc", "1e3", "1,5"]) assert.match(bad({ floor: f }), /Lowest price/, f);
  });
  it("the lowest price starts 5 % under the price of 1 NEAR now, rounded down; with no price it starts empty", () => {
    // 896_500 * 9500 / 10_000 = 851_675
    assert.equal(dcaFloorPrefill("896500"), "0.851675");
    assert.equal(dcaFloorPrefill("10000001"), "9.5");
    for (const p of [null, "", "abc", "1"]) assert.equal(dcaFloorPrefill(p), "", String(p));
  });
});

// ---- view ----
const policy: RawPolicy = policyWith({ ...oldRole, permissions: BUDGET_GUARD_PERMISSIONS });
const oldPolicy: RawPolicy = policyWith(oldRole);
const live = (over: Partial<BudgetLive> = {}, pol: RawPolicy = policy): BudgetLive => ({
  dao: { dao: DAO, factory: FACTORY, code_storage: "0", policy: pol, guards: [] },
  guard: {
    guard_id: GUARD, name: "g1", ready: true, in_role: true, closed: false,
    config: { paused: false, proposal_bond: "0", agents: 1, whitelist: 0, guardians: ["owner.testnet"] },
    policy: { max_per_tx: NEAR(2), max_per_day: NEAR(10), max_pending_per_agent: 3, min_reserve: NEAR(1) },
    window: { spent_in_window: NEAR(1), remaining: NEAR(9), resets_at: "2026-11-07T00:00:00.000Z" },
    agents: [], whitelist: [],
  },
  balance: NEAR(12), withdrawable: NEAR(11), proposals: [], requests: [], plans: [], ...over,
});
const readiness = (over: Partial<DcaReadiness> = {}): DcaReadiness => ({
  version: "1.5.0", latestHash: "HASH",
  registrations: DCA_TOKEN_CONTRACTS.map((contract) => ({ contract, registered: true, min: "1" })), ...over,
});
const view = (over: Partial<DcaView> = {}): DcaView => ({ network: "testnet", readiness: readiness(), quote: "896500", price: "896500", canUpdate: true, ...over });
const values = { connected: "1", amount: "1", every: "1", unit: "days", stop: "times", runs: "5", slippage: "100", floor: "0.85" };
const confirm = { ...values, step: "confirm" };
const NOW = new Date("2026-11-10T00:00:00").getTime();
const panel = (b: BudgetLive, dca: DcaView | null, v: Record<string, string> = values) => renderBudgetPanel("dca", b, null, v, NOW, dca).value;
const startBtn = (h: string) => /<button type="submit" class="btn btn-primary"([^>]*)>Start selling/.exec(h);
// The jargon tests strip the Technical details card and the tags, as the yield tests do.
const JARGON = /\bDAO\b|\b[Pp]roposals?\b|\bGuard\b|[Pp]olicy|[Ww]hitelist|yocto/;
const words = (h: string) => h.replace(/<details class="card tech">[\s\S]*?<\/details>/g, "").replace(/<[^>]+>/g, " ");

describe("DCA drawer: checklist and Start", () => {
  it("Start is enabled only when the checklist is complete", () => {
    const m = startBtn(panel(live(), view(), confirm));
    assert.ok(m, "review step renders");
    assert.doesNotMatch(m[1]!, /disabled/);
  });
  for (const [name, b, dca, label] of [
    ["wallet not connected", live(), view(), "Connect the owner"],
    ["Budget older than 1.5.0", live(), view({ readiness: readiness({ version: "1.4.0" }) }), "Update your Budget so it can swap"],
    ["swaps not allowed", live({}, oldPolicy), view(), "Allow swaps for this Budget"],
    ["USDT not enabled", live(), view({ readiness: readiness({ registrations: [{ contract: "usdt.fakes.testnet", registered: false, min: "1" }] }) }), "Enable USDT for this Budget"],
  ] as const) {
    it(`Start is disabled and the fix is offered: ${name}`, () => {
      const v = name === "wallet not connected" ? { ...confirm, connected: "0" } : confirm;
      const h = panel(b, dca, v);
      assert.match(startBtn(h)![1]!, /disabled/);
      assert.ok(h.includes(label), label);
    });
  }
  for (const [name, dca] of [
    ["readiness not read", view({ readiness: null })],
    ["version unreadable", view({ readiness: readiness({ version: null }) })],
    ["USDT setup unreadable", view({ readiness: readiness({ registrations: null }) })],
  ] as const) {
    it(`an unreadable checklist item blocks Start, it is not read as done: ${name}`, () => {
      assert.match(startBtn(panel(live(), dca, confirm))![1]!, /disabled/);
    });
  }
  it("'Update your Budget' shows only when the version is below 1.5.0", () => {
    assert.match(panel(live(), view({ readiness: readiness({ version: "1.4.0" }) })), /data-action="dca-upgrade"/);
    assert.doesNotMatch(panel(live(), view({ readiness: readiness({ version: "1.5.0" }) })), /Update your Budget|dca-upgrade/);
    assert.doesNotMatch(panel(live(), view({ readiness: readiness({ version: null }) })), /data-action="dca-upgrade"/, "unreadable is not old");
  });
  it("the Update button is disabled when this build has no factory or the hash is unread", () => {
    const old = readiness({ version: "1.2.0" });
    assert.match(panel(live(), view({ readiness: old, canUpdate: false })), /data-action="dca-upgrade" disabled/);
    assert.match(panel(live(), view({ readiness: { ...old, latestHash: null } })), /data-action="dca-upgrade" disabled/);
  });
  it("mainnet shows the testnet-only line, no form and no Start", () => {
    const h = panel(live(), view({ network: "mainnet" }), confirm);
    assert.match(h, /testnet only for now/);
    assert.doesNotMatch(h, /Start selling|name="amount"|type="submit"/);
  });
});

describe("DCA drawer: review", () => {
  it("says it is not investment advice, shows the quote and the total, and warns when the balance is short", () => {
    const h = panel(live({ withdrawable: NEAR(2) }), view(), confirm);
    assert.match(words(h), /not investment advice/);
    assert.match(words(h), /1 NEAR gets about 0\.8965 USDT \(0\.8965 USDT per NEAR\)/);
    assert.match(words(h), /Total to sell\s+5 NEAR/);
    assert.match(words(h), /3 NEAR short of all runs/);
  });
  it("an unreadable quote says so instead of showing a price", () => {
    const h = words(panel(live(), view({ quote: null }), confirm));
    assert.match(h, /current price could not be read/);
    assert.doesNotMatch(h, /gets about/);
  });
  it("a form that no longer passes goes back to edit, not to a review with wrong numbers", () => {
    const h = panel(live(), view(), { ...confirm, amount: "5" });
    assert.doesNotMatch(h, /Start selling/);
    assert.match(h, /value="Review"|>Review</);
  });
  it("the edit step asks for a lowest price, starting 5 % under the current price, and keeps what the owner typed", () => {
    const fresh = panel(live(), view(), { connected: "1" });
    assert.match(fresh, /name="floor"[^>]*value="0\.851675"/);
    assert.match(words(fresh), /Now about 0\.8965 USDT per NEAR; this starts 5 % lower\. A run below it is skipped/);
    assert.match(panel(live(), view(), { connected: "1", floor: "0.7" }), /name="floor"[^>]*value="0\.7"/);
    const unread = panel(live(), view({ price: null }), { connected: "1" });
    assert.match(unread, /name="floor"[^>]*value=""/);
    assert.match(words(unread), /current price could not be read/);
  });
  it("the review shows the lowest price and carries it to the signature", () => {
    const h = panel(live(), view(), confirm);
    assert.match(words(h), /Lowest price\s+0\.85 USDT per NEAR/);
    assert.match(h, /<input type="hidden" name="floor" value="0\.85">/);
    assert.doesNotMatch(words(h), /would be skipped/);
  });
  it("the review warns when today's price is already below the lowest price, as the step would skip", () => {
    // 1 NEAR quotes 896_500; at 1 % the step's own floor is 887_535, under a 0.9 USDT floor (900_000).
    assert.match(words(panel(live(), view(), { ...confirm, floor: "0.9" })), /At today's price a run would be skipped/);
    // 0.8875 USDT -> 887_500 <= 887_535: runs, no warning.
    assert.doesNotMatch(words(panel(live(), view(), { ...confirm, floor: "0.8875" })), /would be skipped/);
  });
  it("offers the slippage choices 0.5 / 1 / 2 % only", () => {
    const h = panel(live(), view());
    assert.deepEqual([...h.matchAll(/<option value="(\d+)"[^>]*>[\d.]+ %<\/option>/g)].map((m) => m[1]!), ["50", "100", "200"]);
  });
});

describe("DCA in plain words", () => {
  const surfaces: Record<string, string> = {
    "edit step": panel(live(), view()),
    "edit step, old Budget": panel(live({}, oldPolicy), view({ readiness: readiness({ version: "1.4.0", registrations: [{ contract: "usdt.fakes.testnet", registered: false, min: "1" }] }) })),
    "edit step, unread": panel(live(), view({ readiness: null })),
    review: panel(live(), view(), confirm),
    "review, short": panel(live({ withdrawable: NEAR(1) }), view({ quote: null }), confirm),
    mainnet: panel(live(), view({ network: "mainnet" })),
    "plans card": renderBudget(live({ plans: [swapPlan()], usdt: "2500000" }), "testnet").value,
    "review, below the lowest price": panel(live(), view(), { ...confirm, floor: "0.9" }),
    "plans card, old plan paused": renderBudget(live({ plans: [swapPlan({ action_type: "swap", status: "paused", pause_reason: "price_floor_required" })] }), "testnet").value,
  };
  for (const [name, h] of Object.entries(surfaces)) {
    it(`${name} has no protocol words outside Technical details`, () => assert.doesNotMatch(words(h), JARGON, `${name}: ${words(h).match(JARGON)?.[0]}`));
  }
});

function swapPlan(over: Partial<BudgetPlan> = {}): BudgetPlan {
  return { plan_id: 4, receiver_id: null, action_type: "swap_with_floor", strategy_id: "dca-near", amount_per_run: NEAR(1), interval_sec: 86_400, runs_total: 5, runs_done: 1, next_run_at: "1794222000000000000", status: "active", pause_reason: null, ...over };
}

describe("Budget page: DCA surfaces", () => {
  it("a swap row reads 'Sell X NEAR for USDT every N unit', not 'Plan #n (swap)'", () => {
    const h = words(renderBudget(live({ plans: [swapPlan({ amount_per_run: "500000000000000000000000", interval_sec: 7_200 })] }), "testnet").value);
    assert.match(h, /Sell 0\.5 NEAR for USDT every 2 hours/);
    assert.doesNotMatch(h, /Plan #4 \(swap\)/);
  });
  it("an old swap plan (no lowest price) still reads as a sale, and its pause says to create it again", () => {
    const h = words(renderBudget(live({ plans: [swapPlan({ action_type: "swap", status: "paused", pause_reason: "price_floor_required" })] }), "testnet").value);
    assert.match(h, /Sell 1 NEAR for USDT every 1 day/);
    assert.match(h, /made before the lowest price was required\. Cancel it and create it again/);
  });
  it("the Plans card offers New payout and New DCA", () => {
    const h = renderBudget(live(), "testnet").value;
    assert.match(h, /data-panel="plan"[^>]*>New payout</);
    assert.match(h, /data-panel="dca"[^>]*>New DCA</);
  });
  it("the USDT line shows on the balance tile only when read", () => {
    assert.match(words(renderBudget(live({ usdt: "2500000" }), "testnet").value), /USDT in your Budget: 2\.5/);
    for (const usdt of [null, undefined]) assert.doesNotMatch(renderBudget(live({ usdt }), "testnet").value, /USDT in your Budget/);
  });
  it("swap technical rows exist only with a swap plan on testnet, inside Technical details", () => {
    const withSwap = renderBudget(live({ plans: [swapPlan()] }), "testnet").value;
    const tech = /<details class="card tech">[\s\S]*?<\/details>/.exec(withSwap)![0];
    assert.ok(tech.includes(DCA_TESTNET.exchange) && tech.includes(DCA_TESTNET.token_out));
    assert.doesNotMatch(renderBudget(live(), "testnet").value, /Swap exchange/);
  });
  it("on the create page the DCA card says 'After setup' and still says testnet only", () => {
    const h = words(renderBudgetCreate(html`x`).value);
    assert.match(h, /DCA NEAR → USDT\s+After setup/);
    assert.match(h, /Testnet only for now/);
  });
  it("?page=budget&strategy=dca-near parses to a strategy link, and a malformed id opens nothing", () => {
    const r = parseRoute("?page=budget&dao=team.sputnik-v2.testnet&strategy=dca-near");
    assert.deepEqual((r as { link?: unknown }).link, { kind: "strategy", id: "dca-near" });
    assert.equal((parseRoute("?page=budget&dao=team.sputnik-v2.testnet&strategy=DCA%20near") as { link?: unknown }).link ?? null, null);
  });
});
