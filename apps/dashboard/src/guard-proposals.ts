// `add_proposal` args the Guard page asks a council member's wallet to sign, pure. The dashboard only creates
// proposals: the council votes in its usual DAO UI, and money moves only when a proposal passes.
import type { GuardCreateArgs } from "./guard-form.ts";

export const GUARD_ROLE = "agent-guard";
/** The role of docs/guard-integration.md step 2: the Guard alone adds and approves transfers, nothing else. */
export const GUARD_PERMISSIONS = ["transfer:AddProposal", "transfer:VoteApprove"];
/** The Guard of an Agent Budget also holds the swap rights (§11.10.3, GĐ31): a swap step is a `call` proposal. */
export const BUDGET_GUARD_PERMISSIONS = [...GUARD_PERMISSIONS, "call:AddProposal", "call:VoteApprove"];
const ROLE_VOTE = { weight_kind: "RoleWeight", quorum: "0", threshold: "1" };
/** One vote entry per proposal kind the rights name, each decided by the role alone. */
const votePolicyFor = (rights: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(["transfer", "call"].filter((k) => rights.some((r) => r.startsWith(`${k}:`))).map((k) => [k, ROLE_VOTE]));
/** Gas on the factory call: `create` refuses less than 215 Tgas, and the sandbox test runs on this. */
export const CREATE_GAS = "220000000000000";
const GUARD_CALL_GAS = "50000000000000";

export interface AddProposalArgs {
  proposal: { description: string; kind: Record<string, unknown> };
}

export interface RawRole {
  name: string;
  kind: unknown;
  permissions: string[];
  vote_policy: Record<string, unknown>;
}

export interface RawPolicy {
  roles: RawRole[];
  proposal_bond: string;
  [key: string]: unknown;
}

/** Sputnik takes FunctionCall args as base64 of the JSON bytes; labels may be any UTF-8. */
export function base64Json(value: unknown): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** P1: the DAO calls `factory.create`; the deposit is the Guard's funding plus the registry record. */
export function createGuardProposal(factory: string, args: GuardCreateArgs, depositYocto: string): AddProposalArgs {
  return {
    proposal: {
      description: `Create Agent Guard ${args.name}.${factory}`,
      kind: {
        FunctionCall: {
          receiver_id: factory,
          actions: [{ method_name: "create", args: base64Json(args), deposit: depositYocto, gas: CREATE_GAS }],
        },
      },
    },
  };
}

const isGroup = (kind: unknown): kind is { Group: string[] } =>
  typeof kind === "object" && kind !== null && Array.isArray((kind as { Group?: unknown }).Group);

/**
 * P2: the whole current policy with `guardId` in the `agent-guard` role (testnet factory DAOs refuse
 * `ChangePolicyAddOrUpdateRole`, so the full policy is proposed). Every other role is kept as it is. A DAO with
 * Guards already gets the new one added to the same role. Null when the role already lists `guardId`.
 */
export function addGuardRoleProposal(policy: RawPolicy, guardId: string, rights: readonly string[] = GUARD_PERMISSIONS): AddProposalArgs | null {
  const existing = policy.roles.find((r) => r.name === GUARD_ROLE);
  const members = existing && isGroup(existing.kind) ? existing.kind.Group : [];
  if (members.includes(guardId)) return null;
  const role: RawRole = {
    name: GUARD_ROLE,
    kind: { Group: [...members, guardId] },
    permissions: [...rights],
    vote_policy: votePolicyFor(rights),
  };
  const roles = existing ? policy.roles.map((r) => (r === existing ? role : r)) : [...policy.roles, role];
  return {
    proposal: { description: `Add ${guardId} to role ${GUARD_ROLE}`, kind: { ChangePolicy: { policy: { ...policy, roles } } } },
  };
}

/**
 * Retire: the whole current policy without `guardId` in the `agent-guard` role, the cut-off for a Guard that
 * cannot be deleted. Other members stay; the role goes when `guardId` was its last member, so no empty role keeps
 * transfer rights. Null when the role does not list `guardId`.
 */
export function removeGuardRoleProposal(policy: RawPolicy, guardId: string): AddProposalArgs | null {
  const existing = policy.roles.find((r) => r.name === GUARD_ROLE);
  const members = existing && isGroup(existing.kind) ? existing.kind.Group : [];
  if (existing === undefined || !members.includes(guardId)) return null;
  const rest = members.filter((m) => m !== guardId);
  const roles =
    rest.length === 0 ? policy.roles.filter((r) => r !== existing) : policy.roles.map((r) => (r === existing ? { ...r, kind: { Group: rest } } : r));
  return {
    proposal: { description: `Remove ${guardId} from role ${GUARD_ROLE}`, kind: { ChangePolicy: { policy: { ...policy, roles } } } },
  };
}

/** True when the `agent-guard` role lists `guardId` and holds the swap rights. */
export function hasSwapRights(policy: RawPolicy, guardId: string): boolean {
  return policy.roles.some((r) => r.name === GUARD_ROLE && isGroup(r.kind) && r.kind.Group.includes(guardId) && ["call:AddProposal", "call:VoteApprove"].every((p) => r.permissions.includes(p)));
}

/**
 * Allow swaps: the whole current policy with the swap rights added to the role that lists `guardId`; other roles and
 * members stay as they are. Null when the role already has the rights or does not list `guardId` (nothing to allow).
 */
export function allowSwapsProposal(policy: RawPolicy, guardId: string): AddProposalArgs | null {
  const existing = policy.roles.find((r) => r.name === GUARD_ROLE && isGroup(r.kind) && r.kind.Group.includes(guardId));
  if (existing === undefined || hasSwapRights(policy, guardId)) return null;
  const role: RawRole = {
    ...existing,
    permissions: [...new Set([...existing.permissions, "call:AddProposal", "call:VoteApprove"])],
    vote_policy: { ...votePolicyFor(["call:"]), ...existing.vote_policy },
  };
  const roles = policy.roles.map((r) => (r === existing ? role : r));
  return { proposal: { description: `Allow swaps for ${guardId}`, kind: { ChangePolicy: { policy: { ...policy, roles } } } } };
}

/** The DAO-only Guard methods the "Propose change" form offers. */
export const GUARD_METHODS = [
  "set_policy",
  "add_agent",
  "remove_agent",
  "set_agent_enabled",
  "add_whitelist",
  "remove_whitelist",
  "add_guardian",
  "unpause",
  "withdraw_excess",
] as const;
export type GuardMethod = (typeof GUARD_METHODS)[number];

export const isGuardMethod = (m: unknown): m is GuardMethod => (GUARD_METHODS as readonly unknown[]).includes(m);

/** The DAO-only plan methods (§11.11.2). Only the Agent Budget page proposes them, so the council form does not list them. */
export type PlanMethod = "create_plan" | "pause_plan" | "resume_plan" | "cancel_plan";

/** Methods that add an entry: the Guard refuses them without a deposit for the storage and refunds the rest to the DAO. */
const STORAGE_METHODS: readonly (GuardMethod | PlanMethod)[] = ["add_agent", "add_whitelist", "add_guardian", "create_plan"];
export const GUARD_STORAGE_DEPOSIT = "10000000000000000000000";
/** `AGENT_GAS_FUND` in contracts/guard: what the Guard gives a new agent account. */
export const AGENT_GAS_FUND_YOCTO = 5n * 10n ** 23n;
/** `add_agent` with a key: the entry's storage, and the fund. What is not used goes back to the DAO. */
export const NEW_AGENT_DEPOSIT = (BigInt(GUARD_STORAGE_DEPOSIT) + AGENT_GAS_FUND_YOCTO).toString();

/** `upgrade` fetches the code (60 Tgas), deploys and migrates (80 Tgas): 200 Tgas leaves room, and `act_proposal` has 300. */
const UPGRADE_GAS = "200000000000000";

/** A FunctionCall proposal DAO → Guard, the only way to change a locked Guard. */
export function guardChangeProposal(
  guardId: string,
  method: GuardMethod | PlanMethod | "upgrade" | "close",
  args: object,
  deposit: string = (STORAGE_METHODS as readonly string[]).includes(method) ? GUARD_STORAGE_DEPOSIT : "0",
): AddProposalArgs {
  return {
    proposal: {
      description: `Agent Guard ${guardId}: ${method}`,
      kind: {
        FunctionCall: {
          receiver_id: guardId,
          actions: [{ method_name: method, args: base64Json(args), deposit, gas: method === "upgrade" ? UPGRADE_GAS : GUARD_CALL_GAS }],
        },
      },
    },
  };
}

/** Update your Budget: the Guard pulls its new code from `factory` and checks it hashes to `codeHash` (read from the factory). */
export function upgradeGuardProposal(guardId: string, factory: string, codeHash: string): AddProposalArgs {
  return guardChangeProposal(guardId, "upgrade", { code_source: factory, code_hash: codeHash });
}

/**
 * Close the Budget (Guard 1.4.0): the Guard deletes its own account and sends all its NEAR, code storage included, to
 * the DAO. The Guard refuses while a request waits on the council or a plan can still run.
 */
export function closeGuardProposal(guardId: string): AddProposalArgs {
  return guardChangeProposal(guardId, "close", {});
}

/** A contract the Budget's account must be registered on before it can hold its token (NEP-145). */
export interface UsdtRegistration {
  contract: string;
  /** `storage_balance_bounds.min` of that contract, yoctoNEAR: the exact deposit. */
  min: string;
}

/** Enable USDT: one `storage_deposit` request per contract that still lacks the DAO, paid by the DAO. */
export function enableUsdtProposals(dao: string, missing: readonly UsdtRegistration[]): AddProposalArgs[] {
  return missing.map((m) => ({
    proposal: {
      description: `Register ${dao} on ${m.contract}`,
      kind: {
        FunctionCall: {
          receiver_id: m.contract,
          actions: [{ method_name: "storage_deposit", args: base64Json({ account_id: dao, registration_only: true }), deposit: m.min, gas: STORAGE_DEPOSIT_GAS }],
        },
      },
    },
  }));
}
const STORAGE_DEPOSIT_GAS = "30000000000000";

/**
 * Which of `labels` (Sputnik proposal kinds: "call" for FunctionCall, "policy" for ChangePolicy) `account` may
 * not propose. Token-weighted `Member` roles are not counted: the page cannot know the account's balance.
 */
export function missingProposePermissions(policy: RawPolicy, account: string, labels: string[]): string[] {
  const perms = policy.roles
    .filter((r) => r.kind === "Everyone" || (isGroup(r.kind) && r.kind.Group.includes(account)))
    .flatMap((r) => r.permissions);
  const can = (label: string) => [`${label}:AddProposal`, `${label}:*`, "*:AddProposal", "*:*"].some((p) => perms.includes(p));
  return labels.filter((l) => !can(l));
}
