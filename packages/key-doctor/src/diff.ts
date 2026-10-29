// diffReports (§4.3): pure. Compares two kd.report.v1 for the same target and lists what changed.
import type { Change, ChangeType, Flag, KdDiff, KdReport, KeyInfo, Member, Severity } from "./types.ts";
import {
  DIFF_TEXT,
  DIFF_UNSEEN_LIMITATION,
  diffMemberErrorLimitation,
  diffRulesetLimitation,
} from "./messages.ts";
import { accountKind } from "./parse.ts";
import { SEVERITY_RANK } from "./rules/thresholds.ts";

const TYPE_ORDER: ChangeType[] = [
  "key_added",
  "role_changed",
  "member_added",
  "flag_raised",
  "member_removed",
  "key_removed",
  "flag_cleared",
  "pq_ready_changed",
];

/** A key whose permission changed under the same public key counts as removed and added. */
const keyId = (k: KeyInfo): string => `${k.public_key}|${JSON.stringify(k.permission)}`;
const flagId = (f: Flag, owner: string): string => `${f.account_id ?? owner}|${f.rule_id}|${f.public_key ?? ""}`;
const isAdmin = (m: Member): boolean => m.flags.some((f) => f.rule_id === "DAO_ADMIN");
const sameRoles = (a: string[], b: string[]): boolean => [...a].sort().join("\n") === [...b].sort().join("\n");

function keyAdded(account: string, k: KeyInfo): Change {
  const base = { type: "key_added" as const, account_id: account, public_key: k.public_key };
  if (k.permission.type === "full_access") {
    return { ...base, severity: "high", details: { permission: "full_access", curve: k.curve }, messages: DIFF_TEXT.fullAccessKeyAdded(account) };
  }
  const receiver = k.permission.receiver_id;
  const details = { permission: "function_call", receiver_id: receiver };
  if (k.flag_ids.includes("FC_DAO_VOTE")) {
    return { ...base, severity: "high", rule_id: "FC_DAO_VOTE", details, messages: DIFF_TEXT.daoVoteKeyAdded(account) };
  }
  return { ...base, severity: "note", details, messages: DIFF_TEXT.appKeyAdded(account, accountKind(receiver) === null ? null : receiver) };
}

function keyRemoved(account: string, k: KeyInfo): Change {
  const fa = k.permission.type === "full_access";
  return {
    type: "key_removed",
    severity: "note",
    account_id: account,
    public_key: k.public_key,
    details: { permission: k.permission.type },
    messages: fa ? DIFF_TEXT.fullAccessKeyRemoved(account) : DIFF_TEXT.appKeyRemoved(account),
  };
}

function flagChanges(before: readonly Flag[], after: readonly Flag[], owner: string): Change[] {
  const prev = new Map(before.map((f) => [flagId(f, owner), f]));
  const curr = new Map(after.map((f) => [flagId(f, owner), f]));
  const out: Change[] = [];
  for (const [id, f] of curr) {
    if (prev.has(id)) continue;
    const account = f.account_id ?? owner;
    out.push({
      type: "flag_raised",
      severity: f.severity,
      account_id: account,
      ...(f.public_key !== undefined && { public_key: f.public_key }),
      rule_id: f.rule_id,
      messages: DIFF_TEXT.flagRaised(account, { vi: f.messages.vi.title, en: f.messages.en.title }),
    });
  }
  for (const [id, f] of prev) {
    if (curr.has(id)) continue;
    const account = f.account_id ?? owner;
    out.push({
      type: "flag_cleared",
      severity: "note",
      account_id: account,
      ...(f.public_key !== undefined && { public_key: f.public_key }),
      rule_id: f.rule_id,
      details: { severity_before: f.severity },
      messages: DIFF_TEXT.flagCleared(account, { vi: f.messages.vi.title, en: f.messages.en.title }),
    });
  }
  return out;
}

function memberChanges(prev: Member, curr: Member, compareFlags: boolean): Change[] {
  const id = curr.account_id;
  const out: Change[] = [];

  if (!sameRoles(prev.roles, curr.roles)) {
    const becameAdmin = isAdmin(curr) && !isAdmin(prev);
    out.push({
      type: "role_changed",
      severity: becameAdmin ? "high" : "note",
      account_id: id,
      details: { roles_before: prev.roles, roles_after: curr.roles },
      messages: DIFF_TEXT.roleChanged(id, becameAdmin),
    });
  }

  const before = new Map(prev.keys.map((k) => [keyId(k), k]));
  const after = new Map(curr.keys.map((k) => [keyId(k), k]));
  for (const [kid, k] of after) if (!before.has(kid)) out.push(keyAdded(id, k));
  for (const [kid, k] of before) if (!after.has(kid)) out.push(keyRemoved(id, k));

  if (compareFlags) out.push(...flagChanges(prev.flags, curr.flags, id));

  if (prev.pq_ready !== curr.pq_ready) {
    out.push({
      type: "pq_ready_changed",
      severity: "note",
      account_id: id,
      details: { pq_ready_before: prev.pq_ready, pq_ready_after: curr.pq_ready },
      messages: DIFF_TEXT.pqReady(id, curr.pq_ready),
    });
  }
  return out;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortChanges(changes: Change[]): Change[] {
  return changes.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
      byCodeUnit(a.account_id, b.account_id) ||
      byCodeUnit(a.public_key ?? "", b.public_key ?? "") ||
      byCodeUnit(a.rule_id ?? "", b.rule_id ?? ""),
  );
}

/**
 * `prev = null` gives the baseline (no changes). `baseline_updated` is always false here:
 * only the caller knows whether it stored `curr` as the new baseline.
 */
export function diffReports(prev: KdReport | null, curr: KdReport): KdDiff {
  if (prev !== null && (prev.target.id !== curr.target.id || prev.target.type !== curr.target.type || prev.chain.network !== curr.chain.network)) {
    throw new Error("diffReports: the two reports are for different targets or networks");
  }

  const limitations = [DIFF_UNSEEN_LIMITATION];
  const changes: Change[] = [];

  if (prev !== null) {
    const compareFlags = prev.ruleset_version === curr.ruleset_version;
    if (!compareFlags) limitations.push(diffRulesetLimitation(prev.ruleset_version, curr.ruleset_version));

    const before = new Map(prev.members.map((m) => [m.account_id, m]));
    const after = new Map(curr.members.map((m) => [m.account_id, m]));

    for (const [id, m] of after) {
      const old = before.get(id);
      if (old === undefined) {
        changes.push({
          type: "member_added",
          severity: "note",
          account_id: id,
          details: { roles: m.roles, status: m.error === null ? m.status : null },
          messages: DIFF_TEXT.memberAdded(id),
        });
      } else if (old.error !== null || m.error !== null) {
        limitations.push(diffMemberErrorLimitation(id));
      } else {
        changes.push(...memberChanges(old, m, compareFlags));
      }
    }
    for (const [id, m] of before) {
      if (after.has(id)) continue;
      changes.push({
        type: "member_removed",
        severity: "note",
        account_id: id,
        details: { roles: m.roles },
        messages: DIFF_TEXT.memberRemoved(id),
      });
    }
    if (compareFlags) changes.push(...flagChanges(prev.dao_flags, curr.dao_flags, curr.target.id));
  }

  sortChanges(changes);
  const counts: Partial<Record<ChangeType, number>> = {};
  for (const c of changes) counts[c.type] = (counts[c.type] ?? 0) + 1;
  const highest = changes[0]?.severity ?? null;

  return {
    schema_version: "kd.diff.v1",
    target: { ...curr.target },
    network: curr.chain.network,
    from: prev === null ? null : { generated_at: prev.generated_at, block_height: prev.chain.block_height },
    to: { generated_at: curr.generated_at, block_height: curr.chain.block_height },
    is_baseline: prev === null,
    baseline_updated: false,
    summary: {
      has_changes: changes.length > 0,
      highest_severity: highest as Severity | null,
      status_before: prev?.summary.status ?? null,
      status_after: curr.summary.status,
      counts,
    },
    changes,
    limitations,
  };
}
