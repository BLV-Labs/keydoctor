import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addAgentProposal, agentProposal, amountFromForm, rulesProposal } from "../src/budget-flow.ts";
import { topUpBlocks, withdrawableYocto, type BudgetLive } from "../src/budget-read.ts";
import { describeKind, renderBudget, renderBudgetPanel, renderBudgetSetup, renderBudgetStart } from "../src/budget-view.ts";
import type { RawPolicy } from "../src/guard-proposals.ts";

const NEAR = (n: number) => `${n}${"0".repeat(24)}`;
const policy: RawPolicy = {
  proposal_bond: "100000000000000000000000",
  roles: [
    { name: "council", kind: { Group: ["owner.testnet"] }, permissions: ["*:*"], vote_policy: {} },
    { name: "agent-guard", kind: { Group: ["g1.guards.testnet"] }, permissions: [], vote_policy: {} },
  ],
};
const live = (over: Partial<BudgetLive> = {}): BudgetLive => ({
  dao: { dao: "team.sputnik-v2.testnet", factory: "guards.testnet", code_storage: "0", policy, guards: [] },
  guard: {
    guard_id: "g1.guards.testnet",
    name: "g1",
    ready: true,
    in_role: true,
    config: { paused: false, proposal_bond: "0", agents: 1, whitelist: 0, guardians: ["owner.testnet"] },
    policy: { max_per_tx: NEAR(1), max_per_day: NEAR(4), max_pending_per_agent: 3, min_reserve: NEAR(1) },
    window: { spent_in_window: NEAR(1), remaining: NEAR(3), resets_at: "2026-11-07T00:00:00.000Z" },
    agents: [{ account_id: "bot.testnet", label: "ops", enabled: true, pending: 0 }],
  },
  balance: NEAR(12),
  withdrawable: NEAR(11),
  proposals: [{ id: 4, proposer: "g1.guards.testnet", description: "pay vendor", kind: { Transfer: { receiver_id: "v.testnet", amount: NEAR(2), token_id: "" } }, status: "InProgress" }],
  requests: [],
  ...over,
});

describe("renderBudget", () => {
  const page = renderBudget(live(), "testnet").value;
  it("shows chain values", () => {
    assert.match(page, /12 NEAR/);
    assert.match(page, /bot\.testnet/);
    assert.match(page, /#4/);
  });
  it("an agent with no label shows no stray separator", () => {
    const base = live();
    const guard = { ...base.guard!, agents: [{ account_id: "bot.testnet", label: "", enabled: true, pending: 0 }] };
    const bare = renderBudget({ ...base, guard }, "testnet").value;
    assert.match(bare, />0 waiting</);
  });
  it("a failed config read is not shown as Active, and Pause is off", () => {
    const base = live();
    const unread = renderBudget({ ...base, guard: { ...base.guard!, config: null } }, "testnet").value;
    assert.match(unread, /Status unknown/);
    const top = unread.slice(unread.indexOf("budget-top"), unread.indexOf('class="actions"'));
    assert.doesNotMatch(top, /Active/);
    assert.match(unread, /data-action="budget-pause"[^>]* disabled>/);
  });
  it("Approve shows what a call spends and that a policy change hands over control", () => {
    const pay = { FunctionCall: { receiver_id: "x.testnet", actions: [{ method_name: "go", deposit: NEAR(5) }] } };
    assert.match(describeKind(pay), /attaching 5 NEAR/);
    assert.match(describeKind({ ChangePolicy: {} }), /who controls this DAO/);
  });
  it("states the true signature count on each owner action", () => {
    assert.match(page, /Top up <span class="sig">1 signature</);
    assert.match(page, /Pause agents <span class="sig">1 signature</);
    assert.match(page, /Withdraw <span class="sig">2 signatures</);
    assert.match(page, /Edit rules <span class="sig">2 signatures</);
    assert.match(page, /Add an agent <span class="sig">2 signatures</);
    assert.match(page, /Remove <span class="sig">2 signatures</);
    assert.doesNotMatch(page, /One signature/i);
  });
  it("carries no mock names and labels the unbuilt features", () => {
    assert.doesNotMatch(page, /Research bot|Team payouts/);
    assert.match(page, /Not available yet/);
  });
  it("shows unknown, not zero, when a read failed", () => {
    const failed = renderBudget(live({ balance: null, proposals: null, requests: null }), "testnet").value;
    assert.match(failed, /unknown/);
    assert.match(failed, /Pending items are unknown, not none/);
  });
});

describe("panels and setup", () => {
  it("withdraw and rules panels say two signatures; top up says one", () => {
    assert.match(renderBudgetPanel("withdraw", live()).value, /2 signatures/);
    assert.match(renderBudgetPanel("rules", live()).value, /2 signatures/);
    assert.match(renderBudgetPanel("topup", live()).value, /1 signature/);
  });
  it("setup says creation is not available while the factory is not deployed", () => {
    assert.match(renderBudgetSetup(false).value, /not available yet: the Agent Budget factory <span class="mono">keydoctor-guards-v2\.testnet<\/span> is not deployed/);
    assert.match(renderBudgetSetup(true).value, /not available yet/);
  });
  it("the start form escapes what was typed", () => {
    assert.doesNotMatch(renderBudgetStart('"><script>', null, "").value, /<script>/);
  });
});

describe("withdrawableYocto", () => {
  it("leaves out the NEAR holding the DAO's storage, which a transfer cannot send", () => {
    assert.equal(withdrawableYocto(NEAR(12), 100_000), NEAR(11));
  });
  it("never goes below zero when storage takes it all", () => {
    assert.equal(withdrawableYocto(NEAR(1), 200_000), "0");
  });
});

describe("topUpBlocks", () => {
  const registry = ["g1.guards.testnet"];
  it("allows a council member when the role lists only this registry Guard", () => {
    assert.deepEqual(topUpBlocks(policy, "owner.testnet", "g1.guards.testnet", registry), []);
  });
  it("blocks a stranger, a missing role entry and a foreign role member", () => {
    assert.deepEqual(topUpBlocks(policy, "stranger.testnet", "g1.guards.testnet", registry), ["NOT_COUNCIL"]);
    assert.deepEqual(topUpBlocks(policy, "owner.testnet", "g2.guards.testnet", registry), ["NO_GUARD_ROLE"]);
    const foreign: RawPolicy = { ...policy, roles: [policy.roles[0]!, { ...policy.roles[1]!, kind: { Group: ["g1.guards.testnet", "evil.testnet"] } }] };
    assert.deepEqual(topUpBlocks(foreign, "owner.testnet", "g1.guards.testnet", registry), ["FOREIGN_GUARD"]);
  });
});

describe("form builders", () => {
  it("amount: rejects zero, junk and more than the balance", () => {
    assert.equal(amountFromForm("0", null).ok, false);
    assert.equal(amountFromForm("abc", null).ok, false);
    assert.equal(amountFromForm("13", NEAR(12)).ok, false);
    assert.deepEqual(amountFromForm("1.5", NEAR(12)), { ok: true, value: { yocto: `15${"0".repeat(23)}`, near: "1.5" } });
  });
  it("rules: per-payment over daily is refused; valid input builds set_policy", () => {
    assert.equal(rulesProposal("g.testnet", { maxPerTx: "5", maxPerDay: "2", maxPending: "3", minReserve: "1" }).ok, false);
    assert.equal(rulesProposal("g.testnet", { maxPerTx: "1", maxPerDay: "2", maxPending: "0", minReserve: "1" }).ok, false);
    const ok = rulesProposal("g.testnet", { maxPerTx: "1", maxPerDay: "2", maxPending: "3", minReserve: "1" });
    assert.equal(ok.ok, true);
    assert.match(ok.ok ? ok.value.proposal.description : "", /set_policy/);
  });
  it("add agent: refuses an eleventh agent here, because a refusal on chain would still show Approved", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `a${i}.testnet`);
    assert.equal(addAgentProposal("g.testnet", { agent: "bot.testnet", label: "x" }, ten).ok, false);
  });
  it("add agent: refuses a bad account, a duplicate and an empty label", () => {
    assert.equal(addAgentProposal("g.testnet", { agent: "Bad Name", label: "x" }, []).ok, false);
    assert.equal(addAgentProposal("g.testnet", { agent: "bot.testnet", label: "x" }, ["bot.testnet"]).ok, false);
    assert.equal(addAgentProposal("g.testnet", { agent: "bot.testnet", label: "" }, []).ok, false);
    assert.equal(addAgentProposal("g.testnet", { agent: "bot.testnet", label: "ops" }, []).ok, true);
  });
  it("agent op: unknown op builds nothing", () => {
    assert.equal(agentProposal("g.testnet", "nope", "bot.testnet"), null);
    assert.match(agentProposal("g.testnet", "remove", "bot.testnet")?.proposal.description ?? "", /remove_agent/);
  });
});
