// `add_proposal` args the Guard page asks a council member's wallet to sign, pure. The dashboard only creates
// proposals: the council votes in its usual DAO UI, and money moves only when a proposal passes.
import type { GuardCreateArgs } from "./guard-form.ts";

export const GUARD_ROLE = "agent-guard";
/** The role of docs/guard-integration.md step 2: the Guard alone adds and approves transfers, nothing else. */
export const GUARD_PERMISSIONS = ["transfer:AddProposal", "transfer:VoteApprove"];
const GUARD_VOTE_POLICY = { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: "1" } };
/** Gas on the factory call: `create` refuses less than 120 Tgas, and the sandbox test runs on this. */
export const CREATE_GAS = "150000000000000";
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
function base64Json(value: unknown): string {
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
export function addGuardRoleProposal(policy: RawPolicy, guardId: string): AddProposalArgs | null {
  const existing = policy.roles.find((r) => r.name === GUARD_ROLE);
  const members = existing && isGroup(existing.kind) ? existing.kind.Group : [];
  if (members.includes(guardId)) return null;
  const role: RawRole = {
    name: GUARD_ROLE,
    kind: { Group: [...members, guardId] },
    permissions: [...GUARD_PERMISSIONS],
    vote_policy: GUARD_VOTE_POLICY,
  };
  const roles = existing ? policy.roles.map((r) => (r === existing ? role : r)) : [...policy.roles, role];
  return {
    proposal: { description: `Add ${guardId} to role ${GUARD_ROLE}`, kind: { ChangePolicy: { policy: { ...policy, roles } } } },
  };
}

/** The DAO-only Guard methods the "Propose change" form offers. */
export type GuardMethod =
  | "set_policy"
  | "add_agent"
  | "remove_agent"
  | "set_agent_enabled"
  | "add_whitelist"
  | "remove_whitelist"
  | "add_guardian"
  | "unpause"
  | "withdraw_excess";

/** A FunctionCall proposal DAO → Guard, the only way to change a locked Guard. */
export function guardChangeProposal(guardId: string, method: GuardMethod, args: object, depositYocto = "0"): AddProposalArgs {
  return {
    proposal: {
      description: `Agent Guard ${guardId}: ${method}`,
      kind: {
        FunctionCall: {
          receiver_id: guardId,
          actions: [{ method_name: method, args: base64Json(args), deposit: depositYocto, gas: GUARD_CALL_GAS }],
        },
      },
    },
  };
}

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
