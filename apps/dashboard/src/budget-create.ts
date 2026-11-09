// Creating an Agent Budget (docs/final-idea.md §11.10.3). Sign 1 makes a DAO only the owner controls; sign 2 is one
// transaction of four calls that makes its Guard, the agent and the Guard's role. Pure: the page reads and signs.
import type { KeyPermission } from "key-doctor";
import { actProposalArgs } from "./budget-flow.ts";
import { nearToYocto } from "./format.ts";
import { formToInput, guardAccountId, MAX_NAME_LEN, validateGuardForm, type GuardCreateArgs, type GuardFormError } from "./guard-form.ts";
import { addGuardRoleProposal, AGENT_GAS_FUND_YOCTO, base64Json, createGuardProposal, GUARD_ROLE, type AddProposalArgs, type RawPolicy } from "./guard-proposals.ts";

export const SPUTNIK_FACTORY = "sputnik-v2.testnet";
const NEAR = 10n ** 24n;
const PROPOSAL_BOND_YOCTO = 10n ** 23n;
/** 72 hours in nanoseconds: an owner who misses a proposal has time to come back to it. */
const PROPOSAL_PERIOD_NS = "259200000000000";
/** The DAO contract takes about 4.78 NEAR of storage; the rest pays for its proposals. */
const DAO_STORAGE_YOCTO = 6n * NEAR;
/** `MIN_GUARD_BALANCE` in contracts/guard. */
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

/** Null when the account holds exactly `publicKey`, limited to the Guard. That limit is what the page tells the owner the file can do. */
export function agentKeyProblem(guardId: string, publicKey: string, keys: readonly ChainKey[] | null): string | null {
  const key = keys?.length === 1 ? keys[0] : undefined;
  const narrow = key?.permission.type === "function_call" && key.permission.receiver_id === guardId;
  return key?.publicKey === publicKey && narrow ? null : "the agent does not have exactly its one key, limited to the Guard";
}

/** The checks of §11.10.3 after sign 2. Sputnik shows a failed call as Approved, so only these say the Budget exists. */
export function budgetCheckFailures(plan: BudgetPlan, agentPublicKey: string, chain: BudgetChain): string[] {
  const failures: string[] = [];
  if (chain.guardDao !== plan.dao) failures.push(`the Guard ${plan.guardId} does not report this DAO`);
  if (chain.guardKeys === null || chain.guardKeys.some((k) => k.permission.type === "full_access")) failures.push("the Guard is not shown to have no full-access key");
  const role = chain.policy?.roles.find((r) => r.name === GUARD_ROLE);
  const members = (role?.kind as { Group?: unknown } | undefined)?.Group;
  if (!Array.isArray(members) || !members.includes(plan.guardId)) failures.push(`the DAO role ${GUARD_ROLE} does not list the Guard`);
  const key = agentKeyProblem(plan.guardId, agentPublicKey, chain.agentKeys);
  if (key !== null) failures.push(key);
  return failures;
}

/** The file `apps/guard-mcp` reads from `AGENT_KEY_PATH`. */
export function agentKeyFile(accountId: string, key: { publicKey: string; privateKey: string }): string {
  return `${JSON.stringify({ account_id: accountId, public_key: key.publicKey, private_key: key.privateKey }, null, 2)}\n`;
}

/** What the page asks before it lets the owner leave with an agent key that only exists in memory. */
export const UNSAVED_KEY_QUESTION = "Your agent's key is not saved yet. If you leave this page, the key is lost and the agent can never sign. Leave anyway?";

/**
 * True while the page holds an agent key that was never downloaded. The page keeps the key only in memory,
 * so leaving loses it for good: on the first live run the owner left before downloading and lost the agent.
 * A new key after an earlier download counts as unsaved again: only the downloaded public key is safe.
 */
export function agentKeyUnsaved(key: { publicKey: string } | null | undefined, savedPublicKey: string | null): boolean {
  return key != null && key.publicKey !== savedPublicKey;
}

// The New agent budget wizard (Keyfence K4). It collects the same form fields `planBudget` reads, one step at a time.

/** The four steps, in the order the owner sees them. */
export const WIZARD_STEPS = ["Fence", "Recipients", "Agent", "Review"] as const;
export const NAME_MIN_CHARS = 3;
const AGENT_LABEL_MAX = 64;

/** A problem under a field. `text` wins over the wording of the code. */
export interface SetupError {
  field: string;
  code: string;
  text?: string;
}

const SETUP_TEXT: Record<string, string> = {
  NAME_EMPTY: "Give your budget a name.",
  NAME_TOO_SHORT: `Use at least ${NAME_MIN_CHARS} characters.`,
  INVALID_NAME: `Use ${NAME_MIN_CHARS} to ${MAX_NAME_LEN} characters: a-z, 0-9, - and _.`,
  INVALID_AMOUNT: "Enter an amount of NEAR above 0, like 1.5.",
  PER_TX_OVER_DAILY: "Per payment cannot be more than per day.",
  INVALID_PENDING: "Enter a whole number from 1 to 100.",
  FUNDING_TOO_LOW: "Start with at least 0.5 NEAR.",
  FUNDING_BELOW_RESERVE: "The starting balance must be at least the amount kept in reserve.",
  FUNDING_UNDER_MINIMUM: "Start with more NEAR: it must cover the waiting payments, the agent's fees and the reserve.",
  NO_AGENTS: "Give your agent a name.",
  AGENT_TOO_LONG: `Use at most ${AGENT_LABEL_MAX} characters.`,
  INVALID_ACCOUNT: "This is not a valid NEAR account.",
  KEEPER_RECIPIENT: "This account cannot be a recipient.",
  LABEL_TOO_LONG: `Use at most ${AGENT_LABEL_MAX} characters.`,
  TOO_MANY_WHITELIST: "Add at most 50 recipients.",
};

/** The words under a field. They never use the chain's own terms. */
export function setupErrorText(e: SetupError): string {
  return e.text ?? SETUP_TEXT[e.code] ?? "Check this value.";
}

const FENCE_FIELDS = ["name", "maxPerTx", "maxPerDay", "maxPendingPerAgent", "minReserve", "funding"];

/** Which step shows a field. */
export function stepOfField(field: string): 1 | 2 | 3 {
  if (field.startsWith("whitelist")) return 2;
  if (field === "agentLabel") return 3;
  return 1;
}

/**
 * What is wrong with the fields of one step, from the same checks `planBudget` runs before signing. Nothing here
 * reads the chain. A field that belongs to a later step is not judged yet.
 */
export function validateSetupStep(step: 1 | 2 | 3, get: (name: string) => string, factory: string): SetupError[] {
  const label = get("agentLabel").trim();
  // Steps 1 and 2 are judged before the agent has a name; a stand-in keeps "no agent" out of their errors.
  const read = (name: string) => (name === "agentLabel" && label === "" ? "agent" : get(name));
  const errors: SetupError[] = [];
  if (step === 1) {
    const name = get("name").trim();
    if (name === "") errors.push({ field: "name", code: "NAME_EMPTY" });
    else if (name.length < NAME_MIN_CHARS && /^[a-z0-9_-]+$/.test(name)) errors.push({ field: "name", code: "NAME_TOO_SHORT" });
  }
  const planned = planBudget(read, null, factory, "0");
  if (!planned.ok) {
    const fields = step === 1 ? FENCE_FIELDS : step === 2 ? null : ["agentLabel"];
    for (const e of planned.errors) {
      const here = fields === null ? e.field.startsWith("whitelist") : fields.includes(e.field);
      if (here && !errors.some((x) => x.field === e.field)) errors.push(e);
    }
  }
  if (step === 3) {
    if (label === "") errors.push({ field: "agentLabel", code: "NO_AGENTS" });
    else if (label.length > AGENT_LABEL_MAX && !errors.some((x) => x.field === "agentLabel")) errors.push({ field: "agentLabel", code: "AGENT_TOO_LONG" });
  }
  return errors;
}

/** One row of the Recipients step. `cap` is a NEAR amount, empty for no limit of its own. */
export interface RecipientRow {
  account: string;
  label: string;
  cap: string;
}

/** The rows as the `whitelist` lines the form parser reads. Empty rows go; a comma in a name would split it, so it becomes a space. */
export function recipientLines(rows: readonly RecipientRow[]): string {
  return rows
    .map((r) => ({ account: r.account.trim(), label: r.label.replace(/,/g, " ").replace(/\s+/g, " ").trim(), cap: r.cap.replace(/near/i, "").trim() }))
    .filter((r) => r.account !== "" || r.label !== "" || r.cap !== "")
    .map((r) => (r.cap !== "" ? `${r.account}, ${r.label}, ${r.cap}` : r.label !== "" ? `${r.account}, ${r.label}` : r.account))
    .join("\n");
}

/** The lines back to rows, for repainting the step. */
export function parseRecipientLines(raw: string): RecipientRow[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((line) => {
      const [account = "", ...rest] = line.split(",").map((p) => p.trim());
      const cap = rest.length >= 2 ? rest.pop()! : "";
      return { account, label: rest.join(" "), cap };
    });
}

/**
 * The owner of a DAO that has the shape sign 1 leaves: one role, one member. That is how a Budget whose second
 * signature never happened looks, until a Guard is found for it. Null for any other policy.
 */
export function unfinishedBudgetOwner(policy: RawPolicy): string | null {
  const role = policy.roles.length === 1 ? policy.roles[0] : undefined;
  const members = (role?.kind as { Group?: unknown } | undefined)?.Group;
  return role?.name === "owner" && Array.isArray(members) && members.length === 1 && typeof members[0] === "string" ? members[0] : null;
}

/** Where the wizard keeps what was typed once sign 1 is through, so Finish setup can pick up. Never a key. */
export const SETUP_FIELDS = ["name", "preset", "maxPerTx", "maxPerDay", "maxPendingPerAgent", "minReserve", "funding", "whitelist", "agentLabel"] as const;
export const savedSetupKey = (dao: string): string => `kd.budget.setup.${dao}`;
