import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addAgentProblem, addAgentProposal, agentProposal, amountFromForm, freshAgentAccount, rulesProposal } from "../src/budget-flow.ts";
import { guardCanClose, parseGuardTxs, parsePlan, parseRequest, topUpBlocks, txUrl, withdrawableYocto, withdrawMaxYocto, type BudgetLive, type BudgetPlan, type BudgetProposal, type BudgetRequest } from "../src/budget-read.ts";
import {
  BALANCED_RULES,
  CAUTIOUS_RULES,
  balanceAfter,
  closeBlockers,
  describeKind,
  everyText,
  fenceSentence,
  inWallet,
  planStatus,
  runwayText,
  renderBudget,
  renderBudgetActivity,
  renderBudgetAgent,
  renderBudgetApprove,
  renderBudgetCreate,
  renderAgentAdded,
  renderAgentKeyReady,
  renderBudgetClose,
  renderBudgetPause,
  renderBudgetPanel,
  withdrawLeftText,
  renderBudgetSetup,
  renderBudgetStart,
  renderRecipientList,
} from "../src/budget-view.ts";
import { renderAgentGuide } from "../src/agent-guide.ts";
import { budgetPolicy } from "../src/budget-create.ts";
import type { RawPolicy } from "../src/guard-proposals.ts";
import { KEEPER_ACCOUNT } from "../src/guard-form.ts";

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
    closed: false,
    config: { paused: false, proposal_bond: "0", agents: 1, whitelist: 0, guardians: ["owner.testnet"] },
    policy: { max_per_tx: NEAR(1), max_per_day: NEAR(4), max_pending_per_agent: 3, min_reserve: NEAR(1) },
    window: { spent_in_window: NEAR(1), remaining: NEAR(3), resets_at: "2026-11-07T00:00:00.000Z" },
    agents: [{ account_id: "bot.testnet", label: "ops", enabled: true, pending: 0 }],
    whitelist: [],
  },
  balance: NEAR(12),
  withdrawable: NEAR(11),
  proposals: [{ id: 4, proposer: "g1.guards.testnet", description: "pay vendor", kind: { Transfer: { receiver_id: "v.testnet", amount: NEAR(2), token_id: "" } }, status: "InProgress", submission_time: null }],
  requests: [],
  plans: [],
  ...over,
});

describe("renderBudget", () => {
  const page = renderBudget(live(), "testnet").value;
  it("shows chain values", () => {
    assert.match(page, /11\.00 NEAR/);
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
    assert.match(describeKind({ ChangePolicy: {} }), /who controls this Budget/);
  });
  it("states the true signature count on each owner action", () => {
    // Page buttons open a pop-up; the pop-up states the count next to the wallet button.
    assert.equal(inWallet(1), "1 signature in your wallet");
    assert.equal(inWallet(2), "2 signatures in your wallet");
    assert.match(renderBudgetPanel("topup", live()).value, /1 signature in your wallet/);
    assert.match(renderBudgetPause(live()).value, /1 signature in your wallet/);
    assert.match(renderBudgetPanel("withdraw", live()).value, /2 signatures in your wallet/);
    assert.match(renderBudgetPanel("rules", live()).value, /2 signatures in your wallet/);
    assert.match(renderBudgetPanel("add-agent", live()).value, /2 signatures in your wallet/);
    assert.match(renderBudgetPanel("recipients", live()).value, /2 signatures in your wallet/);
    const listed = live();
    const withVendor = { ...listed, guard: { ...listed.guard!, whitelist: [{ account_id: "vendor.testnet", label: "", max_per_tx: null }] } };
    assert.match(renderBudgetPanel("plan", withVendor, null, { step: "confirm", receiver: "vendor.testnet", amount: "1", every: "1", unit: "hours", runs: "2", start: "" }).value, /2 signatures in your wallet/);
    const agent = renderBudgetAgent(live().guard!.agents![0]!, live()).value;
    assert.match(agent, /Remove <span class="sig">2 signatures</);
    assert.match(agent, /Turn off agent <span class="sig">2 signatures</);
    assert.doesNotMatch(page, /One signature/i);
  });
  it("the page opens with a plain sentence built from the limits", () => {
    assert.match(page, /1 agent can spend up to 4 NEAR a day and 1 NEAR per payment, only to accounts you approve each time\. Anything else waits for you\./);
    assert.match(fenceSentence(2, "4 NEAR", "1 NEAR", 3), /^2 agents can spend up to 4 NEAR a day and 1 NEAR per payment, only to 3 recipients\./);
    assert.match(fenceSentence(1, "4 NEAR", "1 NEAR", 0), /only to accounts you approve each time/);
    assert.match(fenceSentence(1, "4 NEAR", "1 NEAR", null), /only to the recipients you allow/);
    const base = live();
    assert.match(renderBudget({ ...base, guard: { ...base.guard!, policy: null } }, "testnet").value, /We could not read the limits\. Nothing was changed\./);
  });
  it("tells the owner when the balance is under the reserve and shows the runway", () => {
    const base = live();
    const low = renderBudget({ ...base, withdrawable: NEAR(0) }, "testnet").value;
    assert.match(low, /Agents cannot pay until you top up above 1 NEAR\./);
    assert.doesNotMatch(page, /Agents cannot pay until/);
    assert.equal(runwayText(base), "enough for 11 days at today's pace");
  });
  it("Pause asks first: Cancel has focus, the cost is stated, and no jargon shows", () => {
    const out = renderBudgetPause(live()).value;
    assert.match(out, /Pause this Budget\?/);
    assert.match(out, /<button[^>]*autofocus[^>]*>Cancel</);
    assert.match(out, /data-action="budget-pause-now"/);
    assert.match(out, /Resuming takes 2/);
    assert.match(page, /data-action="budget-pause"/);
    assert.doesNotMatch(page, /data-action="budget-pause-now"/);
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
    assert.doesNotMatch(page, /DCA NEAR/);
  });
  it("shows unknown, not zero, when a read failed", () => {
    const failed = renderBudget(live({ balance: null, proposals: null, requests: null }), "testnet").value;
    assert.match(failed, /unknown/);
    assert.match(failed, /Waiting items are unknown, not none/);
  });
});

describe("words a newcomer sees (§10.4)", () => {
  /** What the page says, without the Technical details block, where these words belong. */
  const shown = (page: string) => page.replace(/<details class="card tech">[\s\S]*?<\/details>/g, "").replace(/<[^>]+>/g, " ");
  // Case matters: the Budget's own account name is "team.sputnik-v2.testnet", and it has to be shown.
  const jargon = /\bDAO\b|\b[Pp]roposals?\b|\bGuard\b|Sputnik/;
  it("the Budget page, its panels and the setup page never name the machinery", () => {
    for (const out of [
      renderBudget(live(), "testnet").value,
      ...(["topup", "withdraw", "rules", "add-agent", "recipients"] as const).map((p) => renderBudgetPanel(p, live()).value),
      renderBudgetSetup(true).value,
    ]) {
      assert.doesNotMatch(shown(out), jargon);
    }
  });
  it("every pop-up and drawer, Pause and Approve included, keeps the machinery out of sight", () => {
    const NOW = Date.UTC(2026, 10, 6);
    const base = live();
    const proposal = { ...base.proposals![0]!, submission_time: `${NOW - 3_600_000}000000` };
    const b = {
      ...base,
      proposals: [proposal],
      requests: [{ request_id: "1", agent: "bot.testnet", receiver_id: "v.testnet", amount: NEAR(2), memo: "invoice", decision: "Pending", reasons: ["NOT_WHITELISTED", "OVER_PER_TX", "OVER_DAILY_LIMIT"], proposal_id: 4, status: "Pending", created_at: `${NOW - 7_200_000}000000` } as BudgetRequest],
      dao: { ...base.dao, policy: { ...base.dao.policy, proposal_period: `${72 * 3_600_000}000000` } as never },
    };
    const expired = { ...b, proposals: [{ ...proposal, submission_time: `${NOW - 80 * 3_600_000}000000` }] };
    const blocked = renderBudgetPanel("topup", live(), null, { blocked: "Only the owner can top up." }).value;
    for (const out of [
      renderBudgetPause(b).value,
      renderBudgetApprove(proposal, b, NOW).value,
      renderBudgetApprove(expired.proposals[0]!, expired, NOW).value,
      renderBudgetPanel("plan", live()).value,
      blocked,
    ]) {
      assert.doesNotMatch(shown(out), jargon);
      assert.doesNotMatch(shown(out), /\byocto|whitelist|policy/i);
    }
  });
  it("the Technical details block still gives the real names, for whoever wants to check them", () => {
    assert.match(renderBudget(live(), "testnet").value, /<details class="card tech">[\s\S]*team\.sputnik-v2\.testnet/);
  });
  it("the agent guide promises only the tools that exist, and tells the agent not to dodge the limits", () => {
    const out = renderAgentGuide("team.sputnik-v2.testnet").value;
    assert.doesNotMatch(shown(out), jargon);
    for (const tool of ["guard_get_policy", "guard_request_transfer", "guard_get_request_status"]) assert.match(out, new RegExp(tool));
    assert.doesNotMatch(out, /strategies_list|plans_status/);
    assert.match(out, /private key/);
  });
});

describe("presets and recipients", () => {
  it("offers Cautious, Balanced and Custom, and Cautious is tighter than Balanced on every limit", () => {
    const form = renderBudgetSetup(true).value;
    for (const p of ["cautious", "balanced", "custom"]) assert.match(form, new RegExp(`data-preset="${p}"`));
    assert.ok(Number(CAUTIOUS_RULES.maxPerTx) < Number(BALANCED_RULES.maxPerTx));
    assert.ok(Number(CAUTIOUS_RULES.maxPerDay) < Number(BALANCED_RULES.maxPerDay));
    assert.ok(Number(CAUTIOUS_RULES.maxPendingPerAgent) < Number(BALANCED_RULES.maxPendingPerAgent));
  });
  it("a chosen preset survives a failed submit, so the owner is not moved to other limits", () => {
    assert.match(renderBudgetSetup(true, { preset: "cautious" }).value, /data-preset="cautious" aria-pressed="true"/);
  });
  it("the recipient panel lists each entry with its own limit and a way to remove it", () => {
    const base = live();
    const out = renderBudgetPanel("recipients", {
      ...base,
      guard: { ...base.guard!, whitelist: [{ account_id: "vendor.testnet", label: "Vendor", max_per_tx: NEAR(2) }] },
    }).value;
    assert.match(out, /vendor\.testnet/);
    assert.match(out, /2 NEAR/);
    assert.match(out, /data-action="budget-recipient-drop" data-account="vendor\.testnet"/);
    assert.match(out, /2 signatures/);
  });
  it("says the list is unknown when it could not be read, not that it is empty", () => {
    const base = live();
    assert.match(renderBudgetPanel("recipients", { ...base, guard: { ...base.guard!, whitelist: null } }).value, /unknown|Could not read/i);
  });
});

describe("panels and setup", () => {
  it("withdraw and rules panels say two signatures; top up says one", () => {
    assert.match(renderBudgetPanel("withdraw", live()).value, /2 signatures/);
    assert.match(renderBudgetPanel("rules", live()).value, /2 signatures/);
    assert.match(renderBudgetPanel("topup", live()).value, /1 signature/);
  });
  it("setup says creation is not available while the factory is not deployed", () => {
    assert.match(renderBudgetSetup(false, {}, [], null, 4).value, /not available yet: the Agent Budget factory <span class="mono">keydoctor-guards-v2\.testnet<\/span> is not deployed/);
    assert.doesNotMatch(renderBudgetSetup(true, {}, [], null, 4).value, /not available yet/);
    assert.match(renderBudgetSetup(true, {}, [], null, 4).value, /2 signatures/);
  });
  it("asks for the agent's name, not an account: the account is always a1.<guard>", () => {
    const form = renderBudgetSetup(true, {}, [], null, 3).value;
    assert.match(form, /name="agentLabel"/);
    assert.doesNotMatch(form, /name="agents"/);
  });
  it("after sign 2 the pop-up asks to save the key first, and says when the chain does not show a finished budget", () => {
    const ready = { label: "Payroll bot", account: "a1.g.testnet", budget: "team", guardId: "g.testnet", dao: "d.testnet", network: "testnet" as const };
    const done = renderAgentKeyReady({ ...ready, problem: null }).value;
    assert.match(done, /data-action="budget-key"/);
    assert.match(done, /Payroll bot is ready/);
    assert.match(renderAgentKeyReady({ ...ready, problem: "the role is missing" }).value, /the role is missing/);
  });
  it("the connect screen gives all three steps of §11.12.7, so a newcomer needs nothing else to plug an agent in", () => {
    const out = renderAgentAdded("a2.g.testnet", "g.testnet", "d.testnet", "testnet", null).value;
    assert.match(out, /data-action="budget-key"/);
    assert.match(out, /Do not send this file to anyone/);
    assert.match(out, /claude mcp add guard/);
    assert.match(out, /GUARD_CONTRACT_ID=g\.testnet/);
    assert.match(out, /AGENT_ACCOUNT_ID=a2\.g\.testnet/);
    assert.match(out, /How much can I still spend today\?/);
    // Following the guide link in this tab would drop the only copy of the key.
    assert.match(out, /href="\?page=budget&amp;dao=d\.testnet&amp;help=agent" target="_blank"/);
  });
  it("the connect screen says so when the chain does not show the agent, rather than call it added", () => {
    const out = renderAgentAdded("a2.g.testnet", "g.testnet", "d.testnet", "testnet", "the agent does not have exactly its one key").value;
    assert.match(out, /does not show a finished agent: the agent does not have exactly its one key/);
    assert.doesNotMatch(out, /is added and checked/);
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
  it("blocks the owner once a second account controls the Budget: money sent here would no longer be theirs alone", () => {
    const shared: RawPolicy = { ...policy, roles: [{ ...policy.roles[0]!, kind: { Group: ["owner.testnet", "other.testnet"] } }, policy.roles[1]!] };
    assert.deepEqual(topUpBlocks(shared, "owner.testnet", "g1.guards.testnet", registry), ["FOREIGN_MEMBER"]);
    const added: RawPolicy = { ...policy, roles: [...policy.roles, { name: "extra", kind: { Group: ["other.testnet"] }, permissions: ["*:*"], vote_policy: {} }] };
    assert.deepEqual(topUpBlocks(added, "owner.testnet", "g1.guards.testnet", registry), ["FOREIGN_MEMBER"]);
  });
  it("blocks a role that names no account: a stranger holding a vote through it could send the money away", () => {
    const everyone: RawPolicy = { ...policy, roles: [...policy.roles, { name: "all", kind: "Everyone", permissions: ["transfer:VoteApprove"], vote_policy: {} }] };
    assert.deepEqual(topUpBlocks(everyone, "owner.testnet", "g1.guards.testnet", registry), ["FOREIGN_MEMBER"]);
    const holders: RawPolicy = { ...policy, roles: [...policy.roles, { name: "holders", kind: { Member: "1" }, permissions: ["*:*"], vote_policy: {} }] };
    assert.deepEqual(topUpBlocks(holders, "owner.testnet", "g1.guards.testnet", registry), ["FOREIGN_MEMBER"]);
  });
  it("reads every role named agent-guard: a second one must not hide behind the good first one", () => {
    const second = (kind: unknown): RawPolicy => ({ ...policy, roles: [...policy.roles, { name: "agent-guard", kind, permissions: ["*:*"], vote_policy: {} }] });
    assert.deepEqual(topUpBlocks(second({ Group: ["evil.testnet"] }), "owner.testnet", "g1.guards.testnet", registry), ["FOREIGN_GUARD"]);
    assert.deepEqual(topUpBlocks(second("Everyone"), "owner.testnet", "g1.guards.testnet", registry), ["FOREIGN_GUARD"]);
  });
  it("still allows the policy a new Budget gets, so a real owner is never locked out of Top up", () => {
    const made = budgetPolicy("owner.testnet");
    const withGuard: RawPolicy = { ...made, roles: [...made.roles, { name: "agent-guard", kind: { Group: ["g1.guards.testnet"] }, permissions: [], vote_policy: {} }] };
    assert.deepEqual(topUpBlocks(withGuard, "owner.testnet", "g1.guards.testnet", registry), []);
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
    const ten = Array.from({ length: 10 }, (_, i) => `a${i}.g.testnet`);
    assert.match(addAgentProblem("x", ten, null) ?? "", /at most 10/);
  });
  it("add agent: refuses an empty name and a Budget that cannot pay the 0.51 NEAR, which would fail after the owner signs", () => {
    assert.match(addAgentProblem("", [], null) ?? "", /Name/);
    assert.match(addAgentProblem("ops", [], "509999999999999999999999") ?? "", /Top up first/);
    assert.equal(addAgentProblem("ops", [], "510000000000000000000000"), null);
    assert.equal(addAgentProblem("ops", [], null), null);
  });
  it("add agent: sends the key and the fund, because without them the Guard makes no account and the key file is useless", () => {
    const kind = addAgentProposal("g.testnet", "a2.g.testnet", "ops", "ed25519:abc").proposal.kind as { FunctionCall: { actions: { method_name: string; args: string; deposit: string }[] } };
    const action = kind.FunctionCall.actions[0]!;
    assert.equal(action.method_name, "add_agent");
    assert.equal(action.deposit, "510000000000000000000000");
    assert.deepEqual(JSON.parse(Buffer.from(action.args, "base64").toString()), { account_id: "a2.g.testnet", label: "ops", public_key: "ed25519:abc" });
  });
  it("add agent: skips a name the chain holds, because a removed agent's account stays and the Guard fails on it", async () => {
    const held = new Set(["a1.g.testnet", "a2.g.testnet"]);
    assert.equal(await freshAgentAccount("g.testnet", async (id) => held.has(id)), "a3.g.testnet");
  });
  it("add agent: stops rather than loop or make a name too long for NEAR", async () => {
    assert.equal(await freshAgentAccount("g.testnet", async () => true), null);
    assert.equal(await freshAgentAccount(`${"g".repeat(60)}.testnet`, async () => false), null);
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
    plan_id: null,
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
    assert.match(out, /More than the 1 NEAR limit per payment/);
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
    assert.match(out, /asked to pay/);
    assert.match(out, /<\/svg>Approved by the rules</);
    assert.doesNotMatch(out, /<\/svg>Paid automatically</);
    assert.doesNotMatch(out, /> paid |ops paid/);
    const done = renderBudgetActivity(live({ requests: [{ ...inFlight, status: "Executed" }] }), "all", NOW).value;
    assert.match(done, /ops paid/);
    assert.match(done, /<\/svg>Paid automatically</);
  });
  it("Activity names a plan step a Scheduled payout: the Guard records itself as the agent, and its account is a technical name", () => {
    const step = request({ agent: "g1.guards.testnet", decision: "Auto", reasons: [], status: "Executed", proposal_id: null });
    const out = renderBudgetActivity(live({ requests: [step] }), "all", NOW).value;
    assert.match(out, /Scheduled payout paid/);
    assert.doesNotMatch(out, /g1\.guards\.testnet/);
  });
  it("Activity names a DCA step a swap: its receiver is the wrap contract, and calling that a payment misleads the owner", () => {
    const dca: BudgetPlan = { plan_id: 2, receiver_id: null, action_type: "swap", strategy_id: "dca-near", amount_per_run: "100000000000000000000000", interval_sec: 300, runs_total: 2, runs_done: 1, next_run_at: null, status: "active", pause_reason: null };
    const step = request({ agent: "g1.guards.testnet", receiver_id: "wrap.testnet", amount: "100000000000000000000000", decision: "Auto", reasons: [], status: "Executed", proposal_id: null, plan_id: 2 });
    const out = renderBudgetActivity(live({ requests: [step], plans: [dca] }), "all", NOW).value.split('<ul class="plain-list">')[1]!;
    assert.match(out, /<\/svg>Swapped automatically</);
    assert.match(out, /DCA sold NEAR for USDT/);
    assert.match(out, /0\.1 NEAR/);
    assert.doesNotMatch(out, /Paid automatically<|paid|wrap\.testnet/);
    const payout = { ...dca, action_type: "transfer", receiver_id: "v.testnet" };
    const pay = renderBudgetActivity(live({ requests: [{ ...step, receiver_id: "v.testnet" }], plans: [payout] }), "all", NOW).value;
    assert.match(pay, /<\/svg>Paid automatically</);
    assert.match(pay, /Scheduled payout paid/);
  });
  it("Activity links a row to its transaction only when the indexer found it", () => {
    const tx = "https://testnet.nearblocks.io/txns/BMPJhtudb7mvxWdqwbzaW6pJX4V5RPiAeBQma1qhDdhf";
    const linked = renderBudgetActivity(live({ requests: [request({ tx_url: tx })] }), "all", NOW).value;
    assert.match(linked, /href="https:\/\/testnet\.nearblocks\.io\/txns\/BMPJ[^"]*" target="_blank" rel="noopener"/);
    assert.doesNotMatch(renderBudgetActivity(live({ requests: [request({ tx_url: null })] }), "all", NOW).value, /nearblocks/);
  });
  it("Needs you lists the proposal that expires first at the top, and the tile quotes that same one", () => {
    const base = dated();
    const older = { ...base.proposals![0]!, id: 3, submission_time: nanos(NOW - 40 * HOUR) };
    const b = { ...base, proposals: [...base.proposals!, older] };
    const out = renderBudget(b, "testnet", "", NOW).value;
    assert.ok(out.indexOf("Request #3") < out.indexOf("Request #4"));
    assert.match(out, /Soonest: 32 hours left/);
  });
  it("a paused Budget offers Resume, with 2 signatures, instead of Pause", () => {
    const base = live();
    const out = renderBudget({ ...base, guard: { ...base.guard!, config: { ...base.guard!.config!, paused: true } } }, "testnet").value;
    assert.match(out, /Resume this Budget <span class="sig">2 signatures</);
    assert.match(out, /Every payment they ask for is rejected/);
    assert.doesNotMatch(out, /data-action="budget-pause"/);
  });
  it("balance after: follows the panel, never goes below zero, and ignores text that is not an amount", () => {
    // From the spendable 11 NEAR, not the 12 the account holds: the card shows 11, so the drawer must agree.
    assert.equal(balanceAfter(live(), "topup", "3"), "14 NEAR");
    assert.equal(balanceAfter(live(), "withdraw", "3"), "8 NEAR");
    assert.equal(balanceAfter(live(), "withdraw", "99"), "0 NEAR");
    assert.equal(balanceAfter(live(), "topup", "abc"), "11 NEAR");
    assert.equal(balanceAfter(live({ withdrawable: null }), "topup", "3"), "unknown");
    assert.match(renderBudgetPanel("topup", live()).value, /Balance now<\/span><span class="sum-value wrap">11 NEAR/);
  });
  it("the balance card shows only what can be spent, and names the NEAR kept for storage", () => {
    // Live on payroll-1: the card said 30 NEAR while 4.7 of it paid for storage, so the owner could plan with NEAR
    // no transfer can send. The card counts only what can leave; the held part is named, never hidden.
    const card = (b: BudgetLive) => renderBudget(b, "testnet").value.match(/Balance<\/span><span class="tile-value">([^<]*)<\/span><span class="tile-note">[^<]*<\/span><span class="tile-note">([^<]*)</);
    assert.deepEqual(card(live())?.slice(1), ["11.00 NEAR", "Plus 1 NEAR kept for account storage, not spendable"]);
    const plain = (b: BudgetLive) => renderBudget(b, "testnet").value.match(/Balance<\/span><span class="tile-value">([^<]*)<\/span><span class="tile-note">([^<]*)<\/span><\/button>/);
    assert.deepEqual(plain(live({ withdrawable: NEAR(12) }))?.slice(1), ["12.00 NEAR", "enough for 12 days at today&#39;s pace"]);
    assert.deepEqual(plain(live({ withdrawable: null }))?.slice(1), ["unknown", "Top up any time"]);
  });
  it("the balance card rounds down to two decimals: 24 decimals do not read, and rounding up would promise NEAR that is not there", () => {
    const plain = (b: BudgetLive) => renderBudget(b, "testnet").value.match(/Balance<\/span><span class="tile-value">([^<]*)</)?.[1];
    assert.equal(plain(live({ withdrawable: "9879654321000000000000001" })), "9.87 NEAR");
    assert.equal(plain(live({ withdrawable: "5000000000000000000000" })), "0.00 NEAR");
  });
  it("Withdraw offers what can leave once the waiting deposits and the new request's storage stay, and names the wallet", () => {
    // WHY: signature 1 stores a proposal on the DAO; a transfer of every spendable yocto then fails at signature 2.
    // 11 spendable − 1 waiting request × 0.1 bond − 0.01 storage margin = 10.89.
    const out = renderBudgetPanel("withdraw", live(), null, { to: "owner.testnet" }).value;
    assert.match(out, /class="btn btn-ghost btn-max" data-action="budget-full" data-amount="10\.89"/);
    assert.match(out, /Up to <button type="button" class="link-btn" data-action="budget-full" data-amount="10\.89">10\.89 NEAR<\/button>/);
    assert.doesNotMatch(out, /Use everything I can/);
    assert.match(out, /owner\.testnet/);
    assert.equal(withdrawMaxYocto(live()), (BigInt(NEAR(11)) - 10n ** 23n - 10n ** 22n).toString());
    assert.equal(withdrawMaxYocto(live({ withdrawable: null })), null);
    assert.equal(withdrawMaxYocto(live({ withdrawable: "1" })), "0");
  });
  it("Withdraw says the wallet shows the deposit at signature 1, and the withdrawal comes at signature 2", () => {
    // WHY: Meteor showed "Send 0.1 NEAR" for a 1 NEAR withdrawal and the owner took it for a bug.
    const out = renderBudgetPanel("withdraw", live(), null, { amount: "1" }).value;
    assert.match(out, /Signature 1: your wallet shows <strong>0\.1 NEAR<\/strong> going to the budget\. That is a refundable deposit that opens the request, not the withdrawal\./);
    assert.match(out, /Signature 2: the budget sends <strong><span id="bp-echo">1 NEAR<\/span><\/strong> to you and returns the 0\.1 NEAR deposit\./);
    const rules = renderBudgetPanel("rules", live()).value;
    assert.match(rules, /not a payment\./);
    assert.match(rules, /the change applies and the budget returns the 0\.1 NEAR deposit\./);
  });
  it("Withdraw warns once nothing would be left for the agents", () => {
    assert.equal(withdrawLeftText(live(), "1").empty, false);
    assert.match(withdrawLeftText(live(), "1").text, /^Agents keep working with what is left: /);
    const all = withdrawLeftText(live(), "10.89");
    assert.equal(all.empty, true);
    assert.equal(all.text, "Your agents will have nothing left to spend until you top up.");
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
    assert.match(renderRecipientList([]).value, /Every payment your agents ask for will wait/);
    assert.match(renderRecipientList([{ account: "a.testnet", label: "", cap: "" }, { account: "b.testnet", label: "", cap: "" }]).value, /data-row="1"/);
  });
});

describe("scheduled payouts on the Budget page", () => {
  const plan = (over: Partial<BudgetPlan> = {}): BudgetPlan => ({
    plan_id: 2, receiver_id: "vendor.testnet", action_type: "transfer", strategy_id: "scheduled-payouts", amount_per_run: NEAR(1),
    interval_sec: 3_600, runs_total: 3, runs_done: 1, next_run_at: "1794222000000000000", status: "active", pause_reason: null, ...over,
  });
  const withList = (over: Partial<BudgetLive> = {}) => {
    const b = live(over);
    return { ...b, guard: { ...b.guard!, whitelist: [{ account_id: "vendor.testnet", label: "vendor", max_per_tx: null }] } };
  };

  it("offers Set up only when the Guard's plans were read: an old Guard without plans must not get a button that fails", () => {
    assert.match(renderBudget(live(), "testnet").value, /data-panel="plan"/);
    const old = renderBudget(live({ plans: null }), "testnet").value;
    assert.doesNotMatch(old, /data-panel="plan"/);
    assert.doesNotMatch(old, /b-later/, "no Scheduled payouts card when the plans could not be read");
    assert.match(old, /Not available right now/);
  });

  it("the Budget page promises no strategy that is not built", () => {
    const page = renderBudget(live(), "testnet").value;
    assert.equal((page.match(/Coming soon/g) ?? []).length, 0);
  });

  it("lists each plan with what it pays, its progress and the actions its status allows", () => {
    const page = renderBudget(live({ plans: [plan(), plan({ plan_id: 3, status: "paused", pause_reason: "insufficient_balance" }), plan({ plan_id: 4, status: "completed", runs_done: 3, next_run_at: null })] }), "testnet").value;
    assert.match(page, /id="plan-2"/);
    assert.match(page, /1 NEAR to vendor\.testnet every 1 hour/);
    assert.match(page, /Run 1 of 3/);
    assert.match(page, /data-op="pause" data-plan="2"/);
    assert.match(page, /data-op="resume" data-plan="3"/);
    assert.match(page, /ran out of NEAR/);
    assert.match(page, /data-op="cancel" data-plan="3"/);
    // An ended plan has nothing left to pause or cancel.
    assert.doesNotMatch(page, /data-plan="4"/);
  });

  it("says intervals in the largest unit that fits", () => {
    assert.equal(everyText(60), "1 minute");
    assert.equal(everyText(7_200), "2 hours");
    assert.equal(everyText(172_800), "2 days");
    assert.equal(everyText(90), "90 seconds");
    assert.equal(planStatus(plan({ status: "paused", pause_reason: "owner" })), "Paused by you");
    assert.equal(planStatus(plan({ status: "paused", pause_reason: "something_new" })), "Paused");
  });

  it("the setup form picks from allowed recipients only, never the keeper", () => {
    const b = live();
    const form = renderBudgetPanel("plan", { ...b, guard: { ...b.guard!, whitelist: [{ account_id: "vendor.testnet", label: "", max_per_tx: null }, { account_id: KEEPER_ACCOUNT, label: "", max_per_tx: null }] } }).value;
    assert.match(form, /<option value="vendor\.testnet"/);
    assert.doesNotMatch(form, new RegExp(`option value="${KEEPER_ACCOUNT.replace(/\./g, "\\.")}"`));
    assert.match(renderBudgetPanel("plan", live()).value, /Add a recipient first/);
  });

  it("the review shows the totals and says a short balance pauses the plan instead of blocking it", () => {
    const values = { step: "confirm", receiver: "vendor.testnet", amount: "1", every: "1", unit: "hours", runs: "20", start: "" };
    const review = renderBudgetPanel("plan", withList(), null, values, Date.UTC(2026, 10, 9)).value;
    assert.match(review, /Start schedule/);
    assert.match(review, /20 NEAR/); // total
    assert.match(review, /9 NEAR short of all runs/); // 20 − 11 spendable
    assert.match(review, /pauses and alerts you/);
    // 24 hourly runs fit in one 24 hours but only 20 exist: 20 NEAR, over the 4 NEAR daily limit.
    assert.match(review, /Up to 20 runs fall in one 24 hours/);
    assert.match(review, /not investment advice/);
  });

  it("a review that no longer passes goes back to the form with the reason", () => {
    const values = { step: "confirm", receiver: "vendor.testnet", amount: "2", every: "1", unit: "hours", runs: "3", start: "" };
    const page = renderBudgetPanel("plan", withList(), null, values).value;
    assert.doesNotMatch(page, /Start schedule/);
    assert.match(page, /per-request limit/);
  });
});

describe("parsePlan", () => {
  const raw = { plan_id: 0, action: { type: "transfer", receiver_id: "vendor.testnet" }, strategy_id: "scheduled-payouts", token_in: "", amount_per_run: NEAR(1), interval_sec: 60, runs_total: 3, runs_done: 0, next_run_at: "1", status: "active", pause_reason: null };
  it("reads the Guard's plan view", () => {
    assert.deepEqual(parsePlan(raw), { plan_id: 0, receiver_id: "vendor.testnet", action_type: "transfer", strategy_id: "scheduled-payouts", amount_per_run: NEAR(1), interval_sec: 60, runs_total: 3, runs_done: 0, next_run_at: "1", status: "active", pause_reason: null });
  });
  it("refuses a malformed row rather than showing wrong numbers", () => {
    assert.equal(parsePlan({ ...raw, amount_per_run: 5 }), null);
    assert.equal(parsePlan({ ...raw, status: "deleted" }), null);
    assert.equal(parsePlan(null), null);
  });
});

describe("budget-read: Activity transaction links", () => {
  // Live rows of payroll-2's Guard (NearBlocks v3, 2026-11-09): plan 2 run 1 and an agent request.
  const rows = {
    data: [
      { transaction_hash: "Feqo6QaBscP13nWUYvWHVz4oWzd4CQeHYcVye7raEY4r", signer_account_id: "keydoctor-keeper.testnet", block_timestamp: "1794242241463748423", actions: [{ action: "FUNCTION_CALL", method: "sync_request" }] },
      { transaction_hash: "BMPJhtudb7mvxWdqwbzaW6pJX4V5RPiAeBQma1qhDdhf", signer_account_id: "keydoctor-keeper.testnet", block_timestamp: "1794242233494867338", actions: [{ action: "FUNCTION_CALL", method: "execute_plan_step" }] },
      { transaction_hash: "czwT4i49Pd9KhZgCookaVmwLapsFBC5wXrmLSDtupDd", signer_account_id: "a1.payroll-2.keydoctor-guards-v2.testnet", block_timestamp: "1794109343305061275", actions: [{ action: "FUNCTION_CALL", method: "request_transfer" }] },
      { transaction_hash: 7, actions: [] },
    ],
  };
  const txs = parseGuardTxs(rows);
  const req = (over: Record<string, unknown>) =>
    parseRequest({ request_id: "x", agent: "a1.payroll-2.keydoctor-guards-v2.testnet", receiver_id: "v.testnet", amount: "1", memo: "", decision: "Auto", reasons: [], status: "Executed", ...over })!;
  it("drops a malformed row instead of linking a broken hash", () => {
    assert.equal(txs.length, 3);
  });
  it("a plan step links its execute_plan_step, not the sync_request that follows it", () => {
    const step = req({ agent: "payroll-2.keydoctor-guards-v2.testnet", plan_id: 2, created_at: "1794242234193069144" });
    assert.equal(txUrl(step, txs, "testnet"), "https://testnet.nearblocks.io/txns/BMPJhtudb7mvxWdqwbzaW6pJX4V5RPiAeBQma1qhDdhf");
  });
  it("an agent request links the agent's own request_transfer", () => {
    assert.equal(txUrl(req({ created_at: "1794109343887039617" }), txs, "testnet"), "https://testnet.nearblocks.io/txns/czwT4i49Pd9KhZgCookaVmwLapsFBC5wXrmLSDtupDd");
  });
  it("links nothing rather than a wrong transaction: another signer, a tx after the request, or one too long before", () => {
    assert.equal(txUrl(req({ agent: "other.testnet", created_at: "1794109343887039617" }), txs, "testnet"), null);
    assert.equal(txUrl(req({ created_at: "1794109343000000000" }), txs, "testnet"), null);
    assert.equal(txUrl(req({ created_at: "1794109399000000000" }), txs, "testnet"), null);
    assert.equal(txUrl(req({}), txs, "testnet"), null);
  });
  it("picks the nearest step when the keeper ran two a few seconds apart", () => {
    const later = { hash: "Later111", signer: "keydoctor-keeper.testnet", method: "execute_plan_step", at: "1794242236000000000" };
    const step = req({ plan_id: 3, created_at: "1794242236700000000" });
    assert.equal(txUrl(step, [...txs, later], "testnet"), "https://testnet.nearblocks.io/txns/Later111");
  });
});

describe("Close this Budget", () => {
  const plan = (status: BudgetPlan["status"]): BudgetPlan => ({
    plan_id: 1, receiver_id: "vendor.testnet", action_type: "transfer", strategy_id: "scheduled-payouts", amount_per_run: NEAR(1),
    interval_sec: 3_600, runs_total: 3, runs_done: 1, next_run_at: null, status, pause_reason: null,
  });
  const withConfig = (over: Partial<NonNullable<BudgetLive["guard"]>>) => {
    const b = live();
    return { ...b, guard: { ...b.guard!, ...over } };
  };

  it("is offered from the Technical details of the Budget page", () => {
    assert.match(renderBudget(live(), "testnet").value, /data-action="budget-close" data-guard="g1\.guards\.testnet"/);
  });

  // Guards before 1.4.0 have no close method: the vote would pass and the call fail.
  it("needs Guard 1.4.0 or later", () => {
    assert.equal(guardCanClose("1.4.0"), true);
    assert.equal(guardCanClose("2.0.0"), true);
    assert.equal(guardCanClose("1.3.9"), false);
    assert.equal(guardCanClose(null), false);
    assert.equal(guardCanClose("dev"), false);
  });

  it("on an older Guard offers only the update, in 2 signatures", () => {
    const out = renderBudgetClose(live(), "1.3.0").value;
    assert.match(out, /runs version 1\.3\.0/);
    assert.match(out, /data-action="budget-close-update"/);
    assert.match(out, /2 signatures in your wallet/);
    assert.doesNotMatch(out, /budget-close-now/);
  });

  // `upgrade` stores the Guard's own copy of the new code from its free NEAR (3.73 NEAR for 1.6.0 on a Guard that runs
  // the factory's global code). Short of that the deploy fails after two signatures and a bond, so Update waits.
  it("on an older Guard short of NEAR for the code, Update is disabled and the page names what to send and where", () => {
    const out = renderBudgetClose(live(), "1.3.0", "2950000000000000000000000").value;
    assert.match(out, /data-action="budget-close-update" disabled/);
    assert.match(out, /Send <strong>2\.95 NEAR<\/strong> to the Budget account <span class="mono">g1\.guards\.testnet<\/span> first/);
  });

  it("on an older Guard with enough NEAR, Update is enabled with no note; an unread check warns but does not block", () => {
    const ok = renderBudgetClose(live(), "1.3.0", "0").value;
    assert.match(ok, /data-action="budget-close-update">/);
    assert.doesNotMatch(ok, /Send <strong>|could not check/);
    const unread = renderBudgetClose(live(), "1.3.0", null).value;
    assert.match(unread, /data-action="budget-close-update">/);
    assert.match(unread, /could not check that the Budget account/);
  });

  it("with an unread version offers nothing to sign", () => {
    const out = renderBudgetClose(live(), null).value;
    assert.match(out, /could not be read/);
    assert.doesNotMatch(out, /budget-close-now|budget-close-update/);
  });

  // The Guard refuses OPEN_REQUESTS / OPEN_PLANS: the page names the cause before the owner pays a bond for a failing call.
  it("names what the Guard would refuse: a waiting payment, an active or paused payout", () => {
    const pending = withConfig({ agents: [{ account_id: "bot.testnet", label: "ops", enabled: true, pending: 2 }] });
    assert.match(closeBlockers(pending, "1.4.0").join(" "), /2 payments still wait/);
    const step: BudgetRequest = { request_id: "r1", agent: "g1.guards.testnet", receiver_id: "vendor.testnet", amount: NEAR(1), memo: "", decision: "NeedsApproval", reasons: [], proposal_id: 7, status: "Pending", created_at: null, plan_id: 1 };
    assert.match(closeBlockers(live({ requests: [step] }), "1.4.0").join(" "), /1 payment still waits/);
    assert.match(closeBlockers(live({ plans: [plan("active")] }), "1.4.0").join(" "), /1 scheduled payout can still run/);
    assert.match(closeBlockers(live({ plans: [plan("paused")] }), "1.4.0").join(" "), /scheduled payout/);
    assert.deepEqual(closeBlockers(live({ plans: [plan("completed"), plan("cancelled")] }), "1.4.0"), []);
  });

  it("says a Guard with more records than it can clear cannot be closed", () => {
    const b = withConfig({ config: { ...live().guard!.config!, requests: "201" } });
    assert.match(closeBlockers(b, "1.4.0").join(" "), /201 payment records/);
    assert.deepEqual(closeBlockers(withConfig({ config: { ...live().guard!.config!, requests: "200" } }), "1.4.0"), []);
  });

  it("a blocked close has no Close button", () => {
    const out = renderBudgetClose(live({ plans: [plan("active")] }), "1.4.0").value;
    assert.match(out, /Before you can close it/);
    assert.doesNotMatch(out, /budget-close-now|budget-close-update/);
  });

  it("a ready close says what is lost for good and where the NEAR goes, in 2 signatures", () => {
    const out = renderBudgetClose(live(), "1.4.0").value;
    assert.match(out, /data-action="budget-close-now" data-guard="g1\.guards\.testnet"/);
    assert.match(out, /goes back to <span class="mono">team\.sputnik-v2\.testnet<\/span>/);
    assert.match(out, /cannot be undone/);
    assert.match(out, /2 signatures in your wallet/);
    assert.match(out, /data-action="close-dialog" aria-label="Close" autofocus/, "the safe button has the first focus");
  });
});
