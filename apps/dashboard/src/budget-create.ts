// Creating an Agent Budget (docs/final-idea.md §11.10.3). Sign 1 makes a DAO only the owner controls; sign 2 is one
// transaction of four calls that makes its Guard, the agent and the Guard's role. Pure: the page reads and signs.
import type { KeyPermission } from "key-doctor";
import { actProposalArgs } from "./budget-flow.ts";
import { nearToYocto } from "./format.ts";
import { formToInput, guardAccountId, validateGuardForm, type GuardCreateArgs, type GuardFormError } from "./guard-form.ts";
import { addGuardRoleProposal, base64Json, createGuardProposal, GUARD_ROLE, type AddProposalArgs, type RawPolicy } from "./guard-proposals.ts";

export const SPUTNIK_FACTORY = "sputnik-v2.testnet";
const NEAR = 10n ** 24n;
const PROPOSAL_BOND_YOCTO = 10n ** 23n;
/** 72 hours in nanoseconds: an owner who misses a proposal has time to come back to it. */
const PROPOSAL_PERIOD_NS = "259200000000000";
/** The DAO contract takes about 4.78 NEAR of storage; the rest pays for its proposals. */
const DAO_STORAGE_YOCTO = 6n * NEAR;
/** `AGENT_GAS_FUND` and `MIN_GUARD_BALANCE` in contracts/guard. */
const AGENT_GAS_FUND_YOCTO = 5n * 10n ** 23n;
const MIN_GUARD_BALANCE_YOCTO = 5n * 10n ** 23n;
const TGAS = 10n ** 12n;

/** The owner alone, with every permission, and no "Everyone" role: nobody else can add a proposal to this DAO. */
export function budgetPolicy(owner: string): RawPolicy {
  return {
    roles: [{ name: "owner", kind: { Group: [owner] }, permissions: ["*:*"], vote_policy: {} }],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
    proposal_bond: PROPOSAL_BOND_YOCTO.toString(),
    proposal_period: PROPOSAL_PERIOD_NS,
    bounty_bond: PROPOSAL_BOND_YOCTO.toString(),
    bounty_forgiveness_period: "86400000000000",
  };
}

/** The arguments of `sputnik-v2.testnet` `create`. */
export function sputnikCreateArgs(name: string, owner: string): { name: string; args: string } {
  return { name, args: base64Json({ config: { name, purpose: "Agent Budget", metadata: "" }, policy: budgetPolicy(owner) }) };
}

/** What the Guard must hold so the agent is not refused at once: every waiting bond, its gas, the reserve, its own floor. */
export function budgetFundingYocto(args: GuardCreateArgs): bigint {
  const agents = BigInt(args.agents.length);
  return BigInt(args.policy.max_pending_per_agent) * agents * PROPOSAL_BOND_YOCTO + agents * AGENT_GAS_FUND_YOCTO + BigInt(args.policy.min_reserve) + MIN_GUARD_BALANCE_YOCTO;
}

export interface BudgetPlan {
  name: string;
  dao: string;
  guardId: string;
  /** The agent has no key yet: sign 2 adds it, so the key is made as late as possible. */
  args: GuardCreateArgs;
  /** What the DAO sends the factory in sign 2. */
  guardDepositYocto: string;
  /** What the owner attaches in sign 1: the DAO's storage plus `guardDepositYocto`. */
  firstDepositYocto: string;
  minFundingYocto: string;
}

export type BudgetPlanResult = { ok: true; plan: BudgetPlan } | { ok: false; errors: GuardFormError[] };

/**
 * The form to a plan. The agent's account is always `a1.<guard>`: the name typed is its label, because the longest
 * Budget name leaves 4 characters of the 64 for an account prefix. `owner` is null while only the rules are checked.
 */
export function planBudget(get: (name: string) => string, owner: string | null, factory: string, codeStorageYocto: string): BudgetPlanResult {
  const input = formToInput(get);
  const guardId = guardAccountId(input.name, factory);
  const label = get("agentLabel").trim();
  const result = validateGuardForm(
    { ...input, agents: label === "" ? [] : [{ account_id: `a1.${guardId}`, label }], guardians: owner === null ? [] : [owner] },
    factory,
    codeStorageYocto,
  );
  if (!result.ok) {
    // `a1.<guard>` is only ever invalid because the name is, which has its own error.
    const errors = result.errors.filter((e) => e.field !== "agents.0.account_id");
    return { ok: false, errors: errors.map((e) => (e.field.startsWith("agents") ? { ...e, field: "agentLabel" } : e)) };
  }
  const minFunding = budgetFundingYocto(result.args);
  if (BigInt(nearToYocto(input.funding) ?? "0") < minFunding) return { ok: false, errors: [{ field: "funding", code: "FUNDING_UNDER_MINIMUM" }] };
  return {
    ok: true,
    plan: {
      name: input.name,
      dao: `${input.name}.${SPUTNIK_FACTORY}`,
      guardId,
      args: result.args,
      guardDepositYocto: result.depositYocto,
      firstDepositYocto: (DAO_STORAGE_YOCTO + BigInt(result.depositYocto)).toString(),
      minFundingYocto: minFunding.toString(),
    },
  };
}

/** Why sign 2 must not run on this DAO, null when it may: its proposal ids are fixed, and only the owner may be able to act. */
export function firstSignatureProblem(policy: RawPolicy, lastProposalId: number, owner: string): string | null {
  const role = policy.roles.length === 1 ? policy.roles[0] : undefined;
  const members = (role?.kind as { Group?: unknown } | undefined)?.Group;
  if (!Array.isArray(members) || members.length !== 1 || members[0] !== owner) return `${owner} is not the only member of this DAO.`;
  if (lastProposalId !== 0) return "This DAO already has proposals, so it is not a new Budget.";
  return null;
}

export interface BudgetCall {
  method: "add_proposal" | "act_proposal";
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
}

/**
 * Sign 2, as measured in the sandbox on a DAO with `budgetPolicy`: 15 + 245 + 15 + 25 = 300 Tgas. Ids 0 and 1 are
 * safe because `firstSignatureProblem` has just seen no proposals and only the owner can add one.
 */
export function secondSignatureCalls(plan: BudgetPlan, factory: string, policy: RawPolicy, agentPublicKey: string): BudgetCall[] {
  const bond = BigInt(policy.proposal_bond);
  const agents = plan.args.agents.map((a) => ({ ...a, public_key: agentPublicKey }));
  const create = createGuardProposal(factory, { ...plan.args, agents }, plan.guardDepositYocto);
  const role = addGuardRoleProposal(policy, plan.guardId);
  if (role === null) throw new Error("The DAO already lists this Guard, so it is not a new Budget.");
  const add = (args: AddProposalArgs): BudgetCall => ({ method: "add_proposal", args: { ...args }, gas: 15n * TGAS, deposit: bond });
  const approve = (id: number, args: AddProposalArgs, tgas: bigint): BudgetCall => ({
    method: "act_proposal",
    args: actProposalArgs({ id, kind: args.proposal.kind }, "VoteApprove"),
    gas: tgas * TGAS,
    deposit: 0n,
  });
  return [add(create), approve(0, create, 245n), add(role), approve(1, role, 25n)];
}

export interface ChainKey {
  publicKey: string;
  permission: KeyPermission;
}

/** What the chain says after sign 2. Null means that read failed, which is not the same as passing. */
export interface BudgetChain {
  guardDao: string | null;
  guardKeys: ChainKey[] | null;
  agentKeys: ChainKey[] | null;
  policy: RawPolicy | null;
}

/** The checks of §11.10.3 after sign 2. Sputnik shows a failed call as Approved, so only these say the Budget exists. */
export function budgetCheckFailures(plan: BudgetPlan, agentPublicKey: string, chain: BudgetChain): string[] {
  const failures: string[] = [];
  if (chain.guardDao !== plan.dao) failures.push(`the Guard ${plan.guardId} does not report this DAO`);
  if (chain.guardKeys === null || chain.guardKeys.some((k) => k.permission.type === "full_access")) failures.push("the Guard is not shown to have no full-access key");
  const role = chain.policy?.roles.find((r) => r.name === GUARD_ROLE);
  const members = (role?.kind as { Group?: unknown } | undefined)?.Group;
  if (!Array.isArray(members) || !members.includes(plan.guardId)) failures.push(`the DAO role ${GUARD_ROLE} does not list the Guard`);
  const key = chain.agentKeys?.length === 1 ? chain.agentKeys[0] : undefined;
  const narrow = key?.permission.type === "function_call" && key.permission.receiver_id === plan.guardId;
  if (key?.publicKey !== agentPublicKey || !narrow) failures.push("the agent does not have exactly its one key, limited to the Guard");
  return failures;
}

/** The file `apps/guard-mcp` reads from `AGENT_KEY_PATH`. */
export function agentKeyFile(accountId: string, key: { publicKey: string; privateKey: string }): string {
  return `${JSON.stringify({ account_id: accountId, public_key: key.publicKey, private_key: key.privateKey }, null, 2)}\n`;
}
