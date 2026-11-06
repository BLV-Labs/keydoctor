import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nearToYocto } from "../src/format.ts";
import { formToInput, MAX_AGENTS, validateGuardForm, type GuardFormInput } from "../src/guard-form.ts";
import {
  addGuardRoleProposal,
  createGuardProposal,
  GUARD_PERMISSIONS,
  GUARD_STORAGE_DEPOSIT,
  guardChangeProposal,
  missingProposePermissions,
  removeGuardRoleProposal,
  type RawPolicy,
} from "../src/guard-proposals.ts";

const FACTORY = "guards.kdfactory.testnet";
const NEAR = 10n ** 24n;
/** The factory's `guard_code_storage` for a 242.5 KB Guard: the DAO pays it, not the factory owner. */
const CODE_STORAGE = "2483120000000000000000000";

const input = (over: Partial<GuardFormInput> = {}): GuardFormInput => ({
  name: "payroll",
  maxPerTx: "1",
  maxPerDay: "2",
  maxPendingPerAgent: "3",
  minReserve: "1",
  funding: "5",
  agents: [{ account_id: "bot.kdoncall.testnet", label: "payroll bot" }],
  whitelist: [{ account_id: "vendor.kdoncall.testnet", label: "vendor", max_per_tx: "" }],
  guardians: [],
  ...over,
});

const codes = (over: Partial<GuardFormInput>) => {
  const r = validateGuardForm(input(over), FACTORY, CODE_STORAGE);
  assert.equal(r.ok, false);
  return r.ok ? [] : r.errors.map((e) => `${e.field}:${e.code}`);
};

const decodeArgs = (b64: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));

const council = (members: string[]) => ({
  name: "council",
  kind: { Group: members },
  permissions: ["*:*"],
  vote_policy: {},
});
const policy = (roles: RawPolicy["roles"]): RawPolicy => ({ roles, proposal_bond: "100000000000000000000000", proposal_period: "604800000000000" });

describe("nearToYocto", () => {
  // A float round trip would put 0.1 NEAR at 100000000000000005000000 yocto: the council would vote on the wrong cap.
  it("converts decimals exactly", () => {
    assert.equal(nearToYocto("0.1"), "100000000000000000000000");
    assert.equal(nearToYocto("1.5"), (15n * NEAR / 10n).toString());
    assert.equal(nearToYocto("0.000000000000000000000001"), "1");
  });
  it("refuses anything that is not a plain decimal", () => {
    for (const bad of ["", "-1", "1e3", "1.", "abc", "0.0000000000000000000000001"]) assert.equal(nearToYocto(bad), null, bad);
  });
});

describe("validateGuardForm", () => {
  it("builds exactly the create args the factory takes, deposit = funding + the Guard's code storage + record storage", () => {
    const r = validateGuardForm(input({ whitelist: [{ account_id: "vendor.kdoncall.testnet", label: "vendor", max_per_tx: "0.5" }] }), FACTORY, CODE_STORAGE);
    assert.ok(r.ok);
    assert.equal(r.guardId, `payroll.${FACTORY}`);
    assert.deepEqual(r.args.policy, {
      max_per_tx: NEAR.toString(),
      max_per_day: (2n * NEAR).toString(),
      max_pending_per_agent: 3,
      min_reserve: NEAR.toString(),
    });
    assert.equal(r.args.whitelist[0]!.max_per_tx, (NEAR / 2n).toString());
    // Short of the code storage, the factory refuses the create with DEPOSIT_TOO_LOW after the council voted.
    assert.equal(r.depositYocto, (5n * NEAR + BigInt(CODE_STORAGE) + 10n ** 22n).toString());
  });

  it("an empty receiver cap means the global per-tx limit, sent as null", () => {
    const r = validateGuardForm(input(), FACTORY, CODE_STORAGE);
    assert.ok(r.ok);
    assert.equal(r.args.whitelist[0]!.max_per_tx, null);
  });

  // The contract refuses these at create: the council would have voted, paid gas and got a refund for nothing.
  it("rejects a per-tx limit above the daily limit", () => {
    assert.deepEqual(codes({ maxPerTx: "3" }), ["maxPerTx:PER_TX_OVER_DAILY"]);
  });
  it("rejects funding under the factory floor, and funding at or under the reserve", () => {
    assert.deepEqual(codes({ funding: "0.4", minReserve: "0" }), ["funding:FUNDING_TOO_LOW"]);
    assert.deepEqual(codes({ funding: "1" }), ["funding:FUNDING_BELOW_RESERVE"]);
  });
  it("enforces the contract caps", () => {
    const agents = Array.from({ length: MAX_AGENTS + 1 }, (_, i) => ({ account_id: `bot${i}.kdoncall.testnet`, label: "" }));
    assert.deepEqual(codes({ agents }), ["agents:TOO_MANY_AGENTS"]);
    assert.deepEqual(codes({ agents: [] }), ["agents:NO_AGENTS"]);
    assert.deepEqual(codes({ maxPendingPerAgent: "0" }), ["maxPendingPerAgent:INVALID_PENDING"]);
    assert.deepEqual(codes({ agents: [{ account_id: "bot.kdoncall.testnet", label: "é".repeat(65) }] }), ["agents.0.label:LABEL_TOO_LONG"]);
  });
  it("rejects account ids the chain would not take, without silently fixing them", () => {
    // Lowercasing "Bot" for the user would mean the council votes on one account and the form showed another.
    assert.deepEqual(codes({ agents: [{ account_id: "Bot.kdoncall.testnet", label: "" }] }), ["agents.0.account_id:INVALID_ACCOUNT"]);
    assert.deepEqual(codes({ guardians: ["not an account"] }), ["guardians.0:INVALID_ACCOUNT"]);
  });
  it("rejects names that are not one lowercase label", () => {
    for (const name of ["", "Pay", "a.b", "x".repeat(33)]) assert.deepEqual(codes({ name }), ["name:INVALID_NAME"], name);
  });
  it("rejects zero and malformed amounts", () => {
    assert.deepEqual(codes({ maxPerDay: "0", maxPerTx: "0" }), ["maxPerTx:INVALID_AMOUNT", "maxPerDay:INVALID_AMOUNT"]);
  });
});

describe("createGuardProposal", () => {
  it("is a FunctionCall to the factory whose args decode back to the form's create args", () => {
    const r = validateGuardForm(input({ agents: [{ account_id: "bot.kdoncall.testnet", label: "bot lương 💸" }] }), FACTORY, CODE_STORAGE);
    assert.ok(r.ok);
    const p = createGuardProposal(FACTORY, r.args, r.depositYocto);
    const call = p.proposal.kind.FunctionCall as { receiver_id: string; actions: { method_name: string; args: string; deposit: string; gas: string }[] };
    assert.equal(call.receiver_id, FACTORY);
    assert.equal(call.actions.length, 1);
    assert.equal(call.actions[0]!.method_name, "create");
    assert.equal(call.actions[0]!.deposit, r.depositYocto);
    assert.ok(BigInt(call.actions[0]!.gas) >= 190n * 10n ** 12n, "the factory refuses less than 190 Tgas");
    assert.deepEqual(decodeArgs(call.actions[0]!.args), r.args, "UTF-8 labels survive the base64 round trip");
  });
});

describe("addGuardRoleProposal", () => {
  const guard = `payroll.${FACTORY}`;
  const kept = council(["alice.testnet"]);

  it("keeps every existing role verbatim and appends a role with exactly the Guard permissions", () => {
    const p = addGuardRoleProposal(policy([kept]), guard);
    assert.ok(p);
    const next = (p.proposal.kind.ChangePolicy as { policy: RawPolicy }).policy;
    assert.deepEqual(next.roles[0], kept);
    assert.equal(next.proposal_bond, "100000000000000000000000", "non-role policy fields are kept");
    assert.deepEqual(next.roles[1], {
      name: "agent-guard",
      kind: { Group: [guard] },
      permissions: GUARD_PERMISSIONS,
      vote_policy: { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: "1" } },
    });
    // More rights (e.g. policy:*) would let a Guard rewrite the DAO; fewer would leave it unable to pay.
    assert.deepEqual(GUARD_PERMISSIONS, ["transfer:AddProposal", "transfer:VoteApprove"]);
  });

  it("adds a second Guard to the existing role instead of a duplicate role, and resets drifted rights", () => {
    const other = `ops.${FACTORY}`;
    const drifted = { name: "agent-guard", kind: { Group: [other] }, permissions: ["*:*"], vote_policy: {} };
    const p = addGuardRoleProposal(policy([kept, drifted]), guard);
    assert.ok(p);
    const roles = (p.proposal.kind.ChangePolicy as { policy: RawPolicy }).policy.roles;
    assert.equal(roles.filter((r) => r.name === "agent-guard").length, 1);
    assert.deepEqual(roles[1]!.kind, { Group: [other, guard] });
    assert.deepEqual(roles[1]!.permissions, GUARD_PERMISSIONS);
  });

  it("returns null when the Guard is already in the role, so the council is not asked twice", () => {
    const p = addGuardRoleProposal(policy([kept, { name: "agent-guard", kind: { Group: [guard] }, permissions: GUARD_PERMISSIONS, vote_policy: {} }]), guard);
    assert.equal(p, null);
  });
});

describe("removeGuardRoleProposal", () => {
  const guard = `payroll.${FACTORY}`;
  const other = `ops.${FACTORY}`;
  const kept = council(["alice.testnet"]);
  const role = (members: string[]) => ({ name: "agent-guard", kind: { Group: members }, permissions: GUARD_PERMISSIONS, vote_policy: {} });
  const rolesOf = (p: ReturnType<typeof removeGuardRoleProposal>) => (p!.proposal.kind.ChangePolicy as { policy: RawPolicy }).policy.roles;

  it("takes only this Guard out: the DAO's other Guards keep paying and every other role is untouched", () => {
    const p = removeGuardRoleProposal(policy([kept, role([other, guard])]), guard);
    assert.ok(p);
    const roles = rolesOf(p);
    assert.deepEqual(roles[0], kept);
    assert.deepEqual(roles[1], role([other]));
    assert.equal((p.proposal.kind.ChangePolicy as { policy: RawPolicy }).policy.proposal_bond, "100000000000000000000000");
  });

  it("drops the role when this was its last Guard, so no empty role keeps transfer rights", () => {
    const roles = rolesOf(removeGuardRoleProposal(policy([kept, role([guard])]), guard));
    assert.deepEqual(roles, [kept]);
  });

  it("returns null when the role does not list the Guard, so the council never votes on a no-op", () => {
    assert.equal(removeGuardRoleProposal(policy([kept]), guard), null);
    assert.equal(removeGuardRoleProposal(policy([kept, role([other])]), guard), null);
  });
});

describe("guardChangeProposal", () => {
  type Call = { receiver_id: string; actions: { method_name: string; args: string; deposit: string }[] };
  it("calls the DAO-only method on the Guard with the args encoded", () => {
    const p = guardChangeProposal(`payroll.${FACTORY}`, "add_agent", { account_id: "bot2.kdoncall.testnet", label: "b2" });
    const call = p.proposal.kind.FunctionCall as Call;
    assert.equal(call.receiver_id, `payroll.${FACTORY}`);
    assert.equal(call.actions[0]!.method_name, "add_agent");
    assert.deepEqual(decodeArgs(call.actions[0]!.args), { account_id: "bot2.kdoncall.testnet", label: "b2" });
  });
  // The Guard charges storage from the attached deposit (INSUFFICIENT_STORAGE_DEPOSIT): a zero deposit would pass the
  // vote and then fail on execution.
  it("attaches a storage deposit only to the methods that add an entry", () => {
    const deposit = (m: "add_agent" | "add_whitelist" | "add_guardian" | "remove_agent" | "unpause") =>
      (guardChangeProposal(`payroll.${FACTORY}`, m, {}).proposal.kind.FunctionCall as Call).actions[0]!.deposit;
    for (const m of ["add_agent", "add_whitelist", "add_guardian"] as const) assert.equal(deposit(m), GUARD_STORAGE_DEPOSIT, m);
    for (const m of ["remove_agent", "unpause"] as const) assert.equal(deposit(m), "0", m);
  });
});

describe("missingProposePermissions", () => {
  const p = policy([
    council(["alice.testnet"]),
    { name: "all", kind: "Everyone", permissions: ["vote:AddProposal"], vote_policy: {} },
    { name: "callers", kind: { Group: ["bob.testnet"] }, permissions: ["call:AddProposal"], vote_policy: {} },
  ]);
  // Warn before signing: a proposal the DAO refuses still costs the wallet a failed transaction.
  it("lists what an account cannot propose", () => {
    assert.deepEqual(missingProposePermissions(p, "alice.testnet", ["call", "policy"]), []);
    assert.deepEqual(missingProposePermissions(p, "bob.testnet", ["call", "policy"]), ["policy"]);
    assert.deepEqual(missingProposePermissions(p, "eve.testnet", ["call", "policy"]), ["call", "policy"]);
  });
});

describe("formToInput", () => {
  it("reads one entry per line and keeps commas inside labels", () => {
    const fields: Record<string, string> = {
      name: " payroll ",
      agents: "bot.kdoncall.testnet, payroll bot\n\n  bot2.kdoncall.testnet  ",
      whitelist: "vendor.kdoncall.testnet, vendor\nrent.kdoncall.testnet, rent, office, 0.5",
      guardians: "alice.testnet\n",
    };
    const input = formToInput((n) => fields[n] ?? "");
    assert.equal(input.name, "payroll");
    assert.deepEqual(input.agents, [
      { account_id: "bot.kdoncall.testnet", label: "payroll bot" },
      { account_id: "bot2.kdoncall.testnet", label: "" },
    ]);
    // Two fields means no cap: the receiver falls back to the global per-tx limit.
    assert.deepEqual(input.whitelist, [
      { account_id: "vendor.kdoncall.testnet", label: "vendor", max_per_tx: "" },
      { account_id: "rent.kdoncall.testnet", label: "rent, office", max_per_tx: "0.5" },
    ]);
    assert.deepEqual(input.guardians, ["alice.testnet"]);
  });
});
