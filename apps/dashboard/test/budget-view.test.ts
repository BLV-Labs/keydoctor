import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addAgentProposal, agentProposal, amountFromForm, rulesProposal } from "../src/budget-flow.ts";
import { topUpBlocks, withdrawableYocto, type BudgetLive, type BudgetProposal, type BudgetRequest } from "../src/budget-read.ts";
import {
  balanceAfter,
  describeKind,
  renderBudget,
  renderBudgetActivity,
  renderBudgetAgent,
  renderBudgetApprove,
  renderBudgetCreate,
  renderBudgetKey,
  renderBudgetPanel,
  renderBudgetSetup,
  renderBudgetStart,
  renderRecipients,
} from "../src/budget-view.ts";
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
  proposals: [{ id: 4, proposer: "g1.guards.testnet", description: "pay vendor", kind: { Transfer: { receiver_id: "v.testnet", amount: NEAR(2), token_id: "" } }, status: "InProgress", submission_time: null }],
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
    const agent = renderBudgetAgent(live().guard!.agents![0]!, live()).value;
    assert.match(agent, /Remove <span class="sig">2 signatures</);
    assert.match(agent, /Turn off agent <span class="sig">2 signatures</);
    assert.doesNotMatch(page, /One signature/i);
  });
  it("shows what each agent spent, and leaves it out for a Guard that cannot report it", () => {
    const agent = { account_id: "bot.testnet", label: "ops", enabled: true, pending: 1 };
    const b = live();
    const withSpend = { ...agent, spent_24h: "1500000000000000000000000" };
    assert.match(renderBudget({ ...b, guard: { ...b.guard!, agents: [withSpend] } }, "testnet").value, /1 waiting · 1\.5 NEAR in last 24h/);
    assert.match(renderBudgetAgent(withSpend, b).value, /1 waiting · 1\.5 NEAR in last 24h/);
    const old = renderBudgetAgent(agent, b).value;
    assert.match(old, /1 waiting/);
    assert.doesNotMatch(old, /in last 24h/, "an unknown amount must not read as spent");
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
    assert.doesNotMatch(renderBudgetSetup(true).value, /not available yet/);
    assert.match(renderBudgetSetup(true).value, /2 signatures/);
  });
  it("asks for the agent's name, not an account: the account is always a1.<guard>", () => {
    const form = renderBudgetSetup(true).value;
    assert.match(form, /name="agentLabel"/);
    assert.doesNotMatch(form, /name="agents"/);
  });
  it("after sign 2 asks to save the key first, and says when the chain does not show a finished budget", () => {
    const done = renderBudgetKey("a1.g.testnet", "d.testnet", null).value;
    assert.match(done, /data-action="budget-key"/);
    assert.match(done, /leaving loses it/);
    assert.match(renderBudgetKey("a1.g.testnet", "d.testnet", "the role is missing").value, /does not show a finished budget: the role is missing/);
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
  it("add agent: refuses a Guard account here, because its old key would pass and the chain's refusal still shows Approved", () => {
    assert.equal(addAgentProposal("g.testnet", { agent: "a1.g.testnet", label: "x" }, []).ok, false);
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

describe("Budget views the owner decides from", () => {
  const NOW = Date.UTC(2026, 10, 6);
  const nanos = (ms: number) => `${ms}000000`;
  const HOUR = 3_600_000;
  const request = (over: Partial<BudgetRequest> = {}): BudgetRequest => ({
    request_id: "1",
    agent: "bot.testnet",
    receiver_id: "v.testnet",
    amount: NEAR(2),
    memo: "invoice 7",
    decision: "Pending",
    reasons: ["OVER_PER_TX"],
    proposal_id: 4,
    status: "Pending",
    created_at: nanos(NOW - 2 * HOUR),
    ...over,
  });
  const dated = (over: Partial<BudgetLive> = {}): BudgetLive => {
    const base = live(over);
    const proposals = base.proposals?.map((p) => ({ ...p, submission_time: nanos(NOW - 11 * HOUR) })) ?? null;
    return { ...base, proposals, dao: { ...base.dao, policy: { ...base.dao.policy, proposal_period: nanos(72 * HOUR) } as never } };
  };
  const proposal = (b: BudgetLive): BudgetProposal => b.proposals![0]!;

  it("Needs you names the agent, the amount and the limit crossed, so the owner need not read a raw proposal", () => {
    const out = renderBudget(dated({ requests: [request()] }), "testnet", "", NOW).value;
    assert.match(out, /ops wants to pay <strong>2 NEAR<\/strong> to <span class="mono">v\.testnet/);
    assert.match(out, /Over your 1 NEAR per-request limit/);
    assert.match(out, /Expires in 61 hours/);
  });
  it("an unknown hold reason is shown as the chain gave it, never dropped", () => {
    const out = renderBudget(dated({ requests: [request({ reasons: ["NEW_CODE"] })] }), "testnet", "", NOW).value;
    assert.match(out, /NEW_CODE/);
  });
  it("no expiry is claimed when the chain gave no submission time", () => {
    assert.doesNotMatch(renderBudget(live({ requests: [request()] }), "testnet", "", NOW).value, /Expires in/);
  });
  it("Approve for a recipient off the list stays locked until the amount is typed back", () => {
    const b = dated({ requests: [request({ reasons: ["NOT_WHITELISTED"] })] });
    const out = renderBudgetApprove(proposal(b), b, NOW).value;
    assert.match(out, /data-expect="2"/);
    assert.match(out, /data-vote="VoteApprove" disabled>/);
    const held = dated({ requests: [request()] });
    assert.doesNotMatch(renderBudgetApprove(proposal(held), held, NOW).value, /data-vote="VoteApprove" disabled>/);
  });
  it("Activity files a payment under the right chip: a refused one is never counted as auto-approved", () => {
    const auto = request({ request_id: "2", receiver_id: "auto.testnet", decision: "Auto", reasons: [], status: "Executed", proposal_id: null });
    const failed = request({ request_id: "3", receiver_id: "failed.testnet", decision: "Auto", reasons: [], status: "Failed" });
    const waiting = request({ request_id: "4", receiver_id: "wait.testnet" });
    const b = live({ requests: [auto, failed, waiting] });
    const shown = (f: "auto" | "rejected" | "waiting") => renderBudgetActivity(b, f, NOW).value;
    assert.match(shown("auto"), /auto\.testnet/);
    assert.doesNotMatch(shown("auto"), /failed\.testnet|wait\.testnet/);
    assert.match(shown("rejected"), /failed\.testnet/);
    assert.match(shown("waiting"), /wait\.testnet/);
    assert.match(renderBudgetActivity(live({ requests: [auto] }), "rejected", NOW).value, /Nothing here yet/);
  });
  it("Activity says paid only once the chain says Executed: an auto-approved request still in flight has not paid anyone", () => {
    const inFlight = request({ decision: "Auto", reasons: [], status: "AutoApproved", proposal_id: null });
    const out = renderBudgetActivity(live({ requests: [inFlight] }), "all", NOW).value;
    assert.match(out, /Auto-approved/);
    assert.match(out, /asked to pay/);
    assert.doesNotMatch(out, /> paid |ops paid/);
    assert.match(renderBudgetActivity(live({ requests: [{ ...inFlight, status: "Executed" }] }), "all", NOW).value, /ops paid/);
  });
  it("Needs you lists the proposal that expires first at the top, and the tile quotes that same one", () => {
    const base = dated();
    const older = { ...base.proposals![0]!, id: 3, submission_time: nanos(NOW - 40 * HOUR) };
    const b = { ...base, proposals: [...base.proposals!, older] };
    const out = renderBudget(b, "testnet", "", NOW).value;
    assert.ok(out.indexOf("Proposal #3") < out.indexOf("Proposal #4"));
    assert.match(out, /Oldest: 32 hours left/);
  });
  it("a paused Budget offers Resume, with the proposal's 2 signatures, instead of Pause", () => {
    const base = live();
    const out = renderBudget({ ...base, guard: { ...base.guard!, config: { ...base.guard!.config!, paused: true } } }, "testnet").value;
    assert.match(out, /Resume agents <span class="sig">2 signatures</);
    assert.match(out, /Every payment they ask for is rejected/);
    assert.doesNotMatch(out, /data-action="budget-pause"/);
  });
  it("balance after: follows the panel, never goes below zero, and ignores text that is not an amount", () => {
    assert.equal(balanceAfter(live(), "topup", "3"), "15 NEAR");
    assert.equal(balanceAfter(live(), "withdraw", "3"), "9 NEAR");
    assert.equal(balanceAfter(live(), "withdraw", "99"), "0 NEAR");
    assert.equal(balanceAfter(live(), "topup", "abc"), "12 NEAR");
    assert.equal(balanceAfter(live({ balance: null }), "topup", "3"), "unknown");
  });
  it("Withdraw offers exactly what the chain says can leave, and names the connected wallet", () => {
    const out = renderBudgetPanel("withdraw", live(), null, { to: "owner.testnet" }).value;
    assert.match(out, /data-amount="11"/);
    assert.match(out, /owner\.testnet/);
  });
  it("the page without a Budget explains itself to a visitor and keeps the form for a connected owner", () => {
    const out = renderBudgetCreate(renderBudgetSetup(true)).value;
    assert.match(out, /data-wallet-off>[\s\S]*data-action="open-wallet"[\s\S]*Coming soon/);
    assert.match(out, /data-wallet-on hidden>[\s\S]*id="budget-setup-form"/);
    assert.doesNotMatch(out, /Set up|Notify me|Contact us/);
  });
  it("setup: the rule fields always post, and a rule error opens them instead of hiding behind Balanced", () => {
    const closed = renderBudgetSetup(true).value;
    assert.match(closed, /id="bs-custom" class="grid-2" hidden/);
    assert.match(closed, /name="maxPerTx"[^>]*value="5"|value="5"[^>]*name="maxPerTx"/);
    const opened = renderBudgetSetup(true, {}, [{ field: "maxPerTx", code: "INVALID_AMOUNT" }]).value;
    assert.doesNotMatch(opened, /id="bs-custom" class="grid-2" hidden/);
  });
  it("no recipient means every payment waits, and the page says so", () => {
    assert.match(renderRecipients("").value, /every payment your agent asks for will wait/);
    assert.match(renderRecipients("a.testnet\n\nb.testnet").value, /data-line="1"/);
  });
});
