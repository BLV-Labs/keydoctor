import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentKeyFile, budgetCheckFailures, budgetPolicy, firstSignatureProblem, planBudget, secondSignatureCalls, sputnikCreateArgs, type BudgetChain, type BudgetPlan } from "../src/budget-create.ts";
import type { RawPolicy } from "../src/guard-proposals.ts";

const FACTORY = "guards.testnet";
const OWNER = "owner.testnet";
const KEY = "ed25519:agentkey";
const NEAR = (n: number) => `${n}${"0".repeat(24)}`;
const form: Record<string, string> = { name: "payroll", agentLabel: "pay bot", maxPerTx: "1", maxPerDay: "2", maxPendingPerAgent: "3", minReserve: "1", funding: "5", whitelist: "" };
const plan = (over: Record<string, string> = {}, owner: string | null = OWNER) => planBudget((n) => ({ ...form, ...over })[n] ?? "", owner, FACTORY, NEAR(2));
const okPlan = (): BudgetPlan => {
  const r = plan();
  assert.ok(r.ok);
  return r.plan;
};

describe("planBudget", () => {
  it("names the DAO, the Guard and the agent from one name, and the typed agent name is only a label", () => {
    const p = okPlan();
    assert.equal(p.dao, "payroll.sputnik-v2.testnet");
    assert.equal(p.guardId, "payroll.guards.testnet");
    assert.deepEqual(p.args.agents, [{ account_id: "a1.payroll.guards.testnet", label: "pay bot" }]);
  });
  it("makes the owner a guardian, because Pause is one direct signature by a guardian", () => {
    assert.deepEqual(okPlan().args.guardians, [OWNER]);
  });
  it("sign 1 pays the DAO's storage on top of everything the DAO must send the factory in sign 2", () => {
    const p = okPlan();
    assert.equal(p.guardDepositYocto, (BigInt(NEAR(7)) + 10n ** 22n).toString());
    assert.equal(p.firstDepositYocto, (BigInt(NEAR(13)) + 10n ** 22n).toString());
  });
  it("refuses funding that leaves the agent refused: bonds 0.3, gas 0.5, reserve 1, Guard floor 0.5", () => {
    const low = plan({ funding: "2.2" });
    assert.deepEqual(low.ok ? [] : low.errors, [{ field: "funding", code: "FUNDING_UNDER_MINIMUM" }]);
    assert.equal(plan({ funding: "2.3" }).ok, true);
  });
  it("shows a missing or long agent name on the field the owner typed in", () => {
    const none = plan({ agentLabel: " " });
    assert.deepEqual(none.ok ? [] : none.errors, [{ field: "agentLabel", code: "NO_AGENTS" }]);
    const long = plan({ agentLabel: "x".repeat(65) });
    assert.deepEqual(long.ok ? [] : long.errors.map((e) => e.field), ["agentLabel"]);
  });
  it("a bad name is one error on the name, not a second one on the agent built from it", () => {
    const bad = plan({ name: "Bad Name" });
    assert.deepEqual(bad.ok ? [] : bad.errors, [{ field: "name", code: "INVALID_NAME" }]);
  });
  it("checks the rules before a wallet is connected, with no guardian yet", () => {
    const r = plan({}, null);
    assert.ok(r.ok);
    assert.deepEqual(r.plan.args.guardians, []);
  });
});

describe("the DAO of sign 1", () => {
  it("lets only the owner act: one role, no Everyone, so nobody else can add a proposal", () => {
    const { roles } = budgetPolicy(OWNER);
    assert.deepEqual(roles.map((r) => r.kind), [{ Group: [OWNER] }]);
  });
  it("keeps 72 hours for a proposal and a 0.1 NEAR bond", () => {
    const p = budgetPolicy(OWNER);
    assert.equal(p.proposal_period, "259200000000000");
    assert.equal(p.proposal_bond, "100000000000000000000000");
  });
  it("sends Sputnik the policy as base64 JSON", () => {
    const sent = JSON.parse(atob(sputnikCreateArgs("payroll", OWNER).args));
    assert.deepEqual(sent.policy, budgetPolicy(OWNER));
    assert.equal(sent.config.name, "payroll");
  });
});

describe("firstSignatureProblem", () => {
  const policy = budgetPolicy(OWNER);
  it("passes the DAO sign 1 just made", () => {
    assert.equal(firstSignatureProblem(policy, 0, OWNER), null);
  });
  it("refuses a DAO someone else can also act in: they could take proposal ids 0 and 1", () => {
    const shared: RawPolicy = { ...policy, roles: [...policy.roles, { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} }] };
    assert.match(firstSignatureProblem(shared, 0, OWNER) ?? "", /only member/);
    assert.match(firstSignatureProblem(policy, 0, "other.testnet") ?? "", /only member/);
  });
  it("refuses a DAO with proposals, because sign 2 approves ids 0 and 1 blind", () => {
    assert.match(firstSignatureProblem(policy, 1, OWNER) ?? "", /already has proposals/);
  });
});

describe("secondSignatureCalls", () => {
  const calls = secondSignatureCalls(okPlan(), FACTORY, budgetPolicy(OWNER), KEY);
  const createArgs = () => {
    const kind = (calls[0]!.args as { proposal: { kind: { FunctionCall: { actions: { args: string; deposit: string; gas: string }[] } } } }).proposal.kind;
    return kind.FunctionCall.actions[0]!;
  };
  it("is add, approve, add, approve within the 300 Tgas a transaction may hold", () => {
    assert.deepEqual(calls.map((c) => c.method), ["add_proposal", "act_proposal", "add_proposal", "act_proposal"]);
    assert.equal(calls.reduce((sum, c) => sum + c.gas, 0n), 300n * 10n ** 12n);
  });
  it("leaves the approval of create enough gas for the 220 Tgas the factory call needs", () => {
    assert.ok(calls[1]!.gas > BigInt(createArgs().gas));
  });
  it("approves exactly what was added, as ids 0 and 1", () => {
    assert.deepEqual(calls[1]!.args, { id: 0, action: "VoteApprove", proposal: (calls[0]!.args as { proposal: { kind: unknown } }).proposal.kind });
    assert.deepEqual(calls[3]!.args, { id: 1, action: "VoteApprove", proposal: (calls[2]!.args as { proposal: { kind: unknown } }).proposal.kind });
  });
  it("pays a bond on each add and nothing on a vote", () => {
    assert.deepEqual(calls.map((c) => c.deposit), [10n ** 23n, 0n, 10n ** 23n, 0n]);
  });
  it("gives the factory the agent's public key and the deposit planned in sign 1", () => {
    const action = createArgs();
    assert.equal(JSON.parse(atob(action.args)).agents[0].public_key, KEY);
    assert.equal(action.deposit, okPlan().guardDepositYocto);
  });
});

describe("budgetCheckFailures", () => {
  const p = okPlan();
  const agentKey = { publicKey: KEY, permission: { type: "function_call" as const, receiver_id: p.guardId, allowance_yocto: null, method_names: ["request_transfer", "sync_request"] } };
  const role = { name: "agent-guard", kind: { Group: [p.guardId] }, permissions: [], vote_policy: {} };
  const good: BudgetChain = { guardDao: p.dao, guardKeys: [], agentKeys: [agentKey], policy: { ...budgetPolicy(OWNER), roles: [...budgetPolicy(OWNER).roles, role] } };
  const fails = (over: Partial<BudgetChain>) => budgetCheckFailures(p, KEY, { ...good, ...over });
  it("passes a Budget that is what the owner signed for", () => {
    assert.deepEqual(fails({}), []);
  });
  it("fails a Guard that belongs to another DAO or that did not appear", () => {
    assert.equal(fails({ guardDao: "x.testnet" }).length, 1);
    assert.equal(fails({ guardDao: null }).length, 1);
  });
  it("fails a Guard with a full-access key, which could rewrite its limits", () => {
    assert.equal(fails({ guardKeys: [{ publicKey: "k", permission: { type: "full_access" } }] }).length, 1);
  });
  it("a read that failed is a failure, not a pass", () => {
    assert.equal(fails({ guardKeys: null }).length, 1);
    assert.equal(fails({ agentKeys: null }).length, 1);
    assert.equal(fails({ policy: null }).length, 1);
  });
  it("fails a role that lost the Guard, a second agent key, a stranger's key and a wider key", () => {
    assert.equal(fails({ policy: budgetPolicy(OWNER) }).length, 1);
    assert.equal(fails({ agentKeys: [agentKey, { ...agentKey, publicKey: "k2" }] }).length, 1);
    assert.equal(fails({ agentKeys: [{ ...agentKey, publicKey: "k2" }] }).length, 1);
    assert.equal(fails({ agentKeys: [{ publicKey: KEY, permission: { type: "full_access" } }] }).length, 1);
  });
});

describe("agentKeyFile", () => {
  it("is the JSON guard-mcp reads", () => {
    assert.deepEqual(JSON.parse(agentKeyFile("a1.g.testnet", { publicKey: "ed25519:p", privateKey: "ed25519:s" })), { account_id: "a1.g.testnet", public_key: "ed25519:p", private_key: "ed25519:s" });
  });
});
