// Network-wide numbers (GĐ10): pure aggregation over kd.report.v1, so the README table is reproducible.
// The output holds aggregates only: no DAO or account names (no leaderboards).
import type { KdReport } from "../src/types.ts";

export interface NetworkStats {
  schema_version: "kd.network_stats.v1";
  network: string;
  block_height: number;
  block_timestamp: string;
  ruleset_version: string;
  active_days: number;
  daos_listed: number;
  daos_active: number;
  daos_scanned: number;
  daos_failed: number;
  council_size: { median: number; p90: number; one_member: number };
  /** DAOs where a single account can approve a transfer. */
  daos_single_vote_transfer: number;
  council_members: number;
  members_unreadable: number;
  members_with_ml_dsa: number;
  members_with_ml_dsa_and_ed25519_full_access: number;
  members_pq_ready: number;
  members_high: number;
  function_call_keys: number;
  function_call_keys_never_used: number;
  full_access_keys: number;
  full_access_keys_never_used: number;
}

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i] as number;
}

export function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** A member who sits in several councils counts once (first report wins: all scans share one block). */
export function aggregate(
  reports: readonly KdReport[],
  meta: { network: string; block_height: number; block_timestamp: string; ruleset_version: string; active_days: number; daos_listed: number; daos_active: number; daos_failed: number },
): NetworkStats {
  const sizes = reports.map((r) => r.summary.council_size).sort((a, b) => a - b);
  const members = new Map<string, KdReport["members"][number]>();
  for (const r of reports) for (const m of r.members) if (!members.has(m.account_id)) members.set(m.account_id, m);

  const s: NetworkStats = {
    schema_version: "kd.network_stats.v1",
    ...meta,
    daos_scanned: reports.length,
    council_size: { median: median(sizes), p90: quantile(sizes, 0.9), one_member: sizes.filter((n) => n === 1).length },
    daos_single_vote_transfer: reports.filter((r) => (r.dao?.transfer_vote_policy ?? []).some((p) => p.approvals_needed === 1)).length,
    council_members: members.size,
    members_unreadable: 0,
    members_with_ml_dsa: 0,
    members_with_ml_dsa_and_ed25519_full_access: 0,
    members_pq_ready: 0,
    members_high: 0,
    function_call_keys: 0,
    function_call_keys_never_used: 0,
    full_access_keys: 0,
    full_access_keys_never_used: 0,
  };
  for (const m of members.values()) {
    if (m.error !== null) {
      s.members_unreadable += 1;
      continue;
    }
    const edFull = m.keys.some((k) => k.curve === "ed25519" && k.permission.type === "full_access");
    if (m.counts.ml_dsa > 0) s.members_with_ml_dsa += 1;
    if (m.counts.ml_dsa > 0 && edFull) s.members_with_ml_dsa_and_ed25519_full_access += 1;
    if (m.pq_ready) s.members_pq_ready += 1;
    if (m.status === "high") s.members_high += 1;
    for (const k of m.keys) {
      const unused = k.use_count === 0;
      if (k.permission.type === "function_call") {
        s.function_call_keys += 1;
        if (unused) s.function_call_keys_never_used += 1;
      } else {
        s.full_access_keys += 1;
        if (unused) s.full_access_keys_never_used += 1;
      }
    }
  }
  return s;
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`);

/** The Markdown table that goes into the README, word for word. */
export function toMarkdown(s: NetworkStats): string {
  return [
    `Measured on ${s.daos_scanned} active Sputnik DAOs on ${s.network} (a proposal in the last ${s.active_days} days), at block ${s.block_height} (${s.block_timestamp}), ruleset ${s.ruleset_version}.`,
    "",
    "| Measure | Value |",
    "|---|---|",
    `| Median council size | ${s.council_size.median} (p90: ${s.council_size.p90}) |`,
    `| DAOs with a one-person council | ${s.council_size.one_member} of ${s.daos_scanned} (${pct(s.council_size.one_member, s.daos_scanned)}) |`,
    `| DAOs where one account can approve a transfer | ${s.daos_single_vote_transfer} of ${s.daos_scanned} (${pct(s.daos_single_vote_transfer, s.daos_scanned)}) |`,
    `| Council members with an ML-DSA key | ${s.members_with_ml_dsa} of ${s.council_members} |`,
    `| ...of them still holding an Ed25519 full-access key | ${s.members_with_ml_dsa_and_ed25519_full_access} of ${s.members_with_ml_dsa} |`,
    `| Council members at high risk | ${s.members_high} of ${s.council_members} (${pct(s.members_high, s.council_members)}) |`,
    `| Function-call keys never used | ${s.function_call_keys_never_used} of ${s.function_call_keys} (${pct(s.function_call_keys_never_used, s.function_call_keys)}) |`,
    `| Full-access keys never used | ${s.full_access_keys_never_used} of ${s.full_access_keys} (${pct(s.full_access_keys_never_used, s.full_access_keys)}) |`,
    "",
    `${s.daos_failed} DAO scans failed and ${s.members_unreadable} council members could not be read; they are left out.`,
  ].join("\n");
}
