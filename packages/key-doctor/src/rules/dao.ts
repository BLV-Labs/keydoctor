import type { DaoRole, KeyInfo, TransferVotePolicy } from "../types.ts";
import type { Policy, PolicyRole } from "../parse.ts";
import { roleLabel, roleTokenWeightLimitation, rolePolicyLimitation, roleTransferLimitation } from "../messages.ts";
import type { RuleHit } from "./key.ts";
import { ADMIN_APPROVALS, ADMIN_LABELS, COUNCIL_SMALL_MAX } from "./thresholds.ts";

export interface PolicyAnalysis {
  roles: DaoRole[];
  transferVotePolicy: TransferVotePolicy[];
  /** Distinct, in first-seen order. */
  council: string[];
  /** Group roles that hold each member, in policy order. */
  memberRoles: Map<string, string[]>;
  adminMembers: Set<string>;
  limitations: string[];
  proposalBond: string;
}

/** `kind:action`, `kind:*`, `*:action` or `*:*` (Policy::can_execute_action). */
function permits(role: PolicyRole, kind: string, action: string): boolean {
  return [`${kind}:${action}`, `${kind}:*`, `*:${action}`, "*:*"].some((p) => role.permissions.includes(p));
}

function toWeight(t: Policy["defaultVotePolicy"]["threshold"], total: bigint): bigint {
  const w = t.kind === "weight" ? t.value : (t.n * total) / t.d + 1n;
  return w < total ? w : total;
}

/** Null unless the role is a Group voting by RoleWeight. */
function approvalsNeeded(policy: Policy, role: PolicyRole, label: string): number | null {
  const vp = role.votePolicy[label] ?? policy.defaultVotePolicy;
  if (role.kind !== "group" || vp.weightKind !== "RoleWeight") return null;
  const total = BigInt(new Set(role.members).size);
  const w = toWeight(vp.threshold, total);
  return Number(vp.quorum > w ? vp.quorum : w);
}

export function analyzePolicy(policy: Policy): PolicyAnalysis {
  const roles: DaoRole[] = [];
  const transferVotePolicy: TransferVotePolicy[] = [];
  const council = new Set<string>();
  const memberRoles = new Map<string, string[]>();
  const adminMembers = new Set<string>();
  const limitations: string[] = [];

  policy.roles.forEach((role, i) => {
    const canTransfer = permits(role, "transfer", "VoteApprove");
    roles.push({ name: role.name, kind: role.kind, members: role.kind === "group" ? role.members : [], can_approve_transfer: canTransfer });
    const label = roleLabel(role.name, i);
    const adminLabels = ADMIN_LABELS.filter((l) => permits(role, l, "VoteApprove"));
    const tokenWeighted = (l: string) => (role.votePolicy[l] ?? policy.defaultVotePolicy).weightKind === "TokenWeight";

    let isAdmin = false;
    if (canTransfer) {
      const vp = role.votePolicy.transfer ?? policy.defaultVotePolicy;
      transferVotePolicy.push({
        role: role.name,
        weight_kind: vp.weightKind,
        threshold: vp.rawThreshold,
        approvals_needed: approvalsNeeded(policy, role, "transfer"),
      });
      if (role.kind !== "group") {
        limitations.push(roleTransferLimitation(label));
      }
    }
    if (adminLabels.length > 0 && role.kind !== "group") {
      limitations.push(rolePolicyLimitation(label));
    }
    if (role.kind === "group") {
      isAdmin = adminLabels.some((l) => approvalsNeeded(policy, role, l) === ADMIN_APPROVALS);
      if ((canTransfer && tokenWeighted("transfer")) || adminLabels.some(tokenWeighted)) {
        limitations.push(roleTokenWeightLimitation(label));
      }
      for (const m of role.members) {
        memberRoles.set(m, [...(memberRoles.get(m) ?? []).filter((n) => n !== role.name), role.name]);
        if (isAdmin) adminMembers.add(m);
        if (canTransfer || adminLabels.length > 0) council.add(m);
      }
    }
  });

  return {
    roles,
    transferVotePolicy,
    council: [...council],
    memberRoles,
    adminMembers,
    limitations,
    proposalBond: policy.proposalBond,
  };
}

/** Rules that need the DAO context, for one council member. */
export function daoMemberRules(keys: KeyInfo[], dao: { daoId: string; admin: boolean }): RuleHit[] {
  const hits: RuleHit[] = [];
  if (dao.admin) hits.push({ rule_id: "DAO_ADMIN", scope: "dao", evidence: { approvals_needed: ADMIN_APPROVALS } });
  for (const key of keys) {
    const p = key.permission;
    if (p.type !== "function_call" || p.receiver_id !== dao.daoId) continue;
    const anyMethod = p.method_names.length === 0;
    if (anyMethod || p.method_names.includes("act_proposal")) {
      hits.push({
        rule_id: "FC_DAO_VOTE",
        scope: "key",
        public_key: key.public_key,
        receiver_id: dao.daoId,
        evidence: { any_method: anyMethod },
      });
    }
  }
  return hits;
}

export function councilSmallHit(councilSize: number): RuleHit | null {
  return councilSize >= 1 && councilSize <= COUNCIL_SMALL_MAX
    ? { rule_id: "COUNCIL_SMALL", scope: "dao", evidence: { council_size: councilSize } }
    : null;
}
