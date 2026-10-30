// Shared functions behind the MCP tools and the bot commands (§8.2, §8.3).
import {
  diffReports,
  listProposals as listDaoProposals,
  resolveTarget,
  scanTarget,
  toSummary,
  type Flag,
  type KdDiff,
  type KdReport,
  type KdReportSummary,
  type KeyInfo,
  type ListProposalsResult,
  type Network,
} from "key-doctor";
import type { Env } from "./env.ts";
import { latestSnapshot, pruneSnapshots, saveSnapshot } from "./store/snapshots.ts";

export interface TargetArgs {
  target: string;
  network?: Network;
}

/**
 * The configured RPC endpoints for a network: `RPC_URL_*` holds one URL or a comma-separated list, tried in
 * order on rate limits and transport failures. Undefined means the library default (DEFAULT_RPC_URLS).
 */
export function rpcUrlsFor(env: Env, network: Network): string[] | undefined {
  const raw = network === "mainnet" ? env.RPC_URL_MAINNET : env.RPC_URL_TESTNET;
  const urls = (raw ?? "").split(",").map((u) => u.trim()).filter((u) => u !== "");
  return urls.length > 0 ? urls : undefined;
}

/** Resolves the target (throws INVALID_TARGET) and picks the configured RPC for its network. */
export function resolve(args: TargetArgs, env: Env): { id: string; network: Network; rpcUrl?: string[] } {
  const t = resolveTarget(args.target, args.network === undefined ? {} : { network: args.network });
  const rpcUrl = rpcUrlsFor(env, t.network);
  return { id: t.id, network: t.network, ...(rpcUrl ? { rpcUrl } : {}) };
}

export function scan(args: TargetArgs, env: Env): Promise<KdReport> {
  const t = resolve(args, env);
  return scanTarget(t.id, { network: t.network, ...(t.rpcUrl && { rpcUrl: t.rpcUrl }) });
}

/** UC2: never reads or writes D1. */
export async function diagnose(
  args: TargetArgs & { detail?: "summary" | "full" },
  env: Env,
): Promise<KdReport | KdReportSummary> {
  const report = await scan(args, env);
  return args.detail === "full" ? report : toSummary(report);
}

/**
 * UC3: compares a fresh scan with the stored baseline. The baseline moves only when there is none yet
 * or when `update_baseline` is true.
 */
export async function compare(args: TargetArgs & { update_baseline?: boolean }, env: Env): Promise<KdDiff> {
  const t = resolve(args, env);
  const baseline = await latestSnapshot(env.DB, t.id, t.network);
  const curr = await scan(args, env);
  const diff = diffReports(baseline, curr);
  if (baseline === null || args.update_baseline === true) {
    await saveSnapshot(env.DB, curr);
    await pruneSnapshots(env.DB, t.id, t.network);
    return { ...diff, baseline_updated: true };
  }
  return diff;
}

export interface KeyRow extends Omit<KeyInfo, "flag_ids"> {
  account_id: string;
  roles: string[];
  flags: Pick<Flag, "rule_id" | "severity" | "messages">[];
}

export interface KeyList {
  target: { type: "dao" | "account"; id: string };
  chain: KdReport["chain"];
  ruleset_version: string;
  total: number;
  keys: KeyRow[];
  /** Members whose keys could not be read; they are left out of `keys`. */
  errors: string[];
}

/**
 * The dashboard's key table as flat rows: one per access key, with the member it belongs to, what it is approved
 * for, its age and use count, and the flags raised on it. A projection of kd.report.v1; never reads or writes D1.
 */
export async function listKeys(
  args: TargetArgs & { account_id?: string; permission?: "full_access" | "function_call"; flagged_only?: boolean },
  env: Env,
): Promise<KeyList> {
  const report = await scan(args, env);
  const errors = [...report.errors];
  const rows: KeyRow[] = [];
  for (const m of report.members) {
    if (m.error !== null) {
      errors.push(`${m.account_id}: ${m.error}`);
      continue;
    }
    if (args.account_id !== undefined && m.account_id !== args.account_id) continue;
    for (const { flag_ids, ...key } of m.keys) {
      if (args.permission !== undefined && key.permission.type !== args.permission) continue;
      const flags = m.flags
        .filter((f) => f.public_key === key.public_key || (f.public_key === undefined && flag_ids.includes(f.rule_id)))
        .map(({ rule_id, severity, messages }) => ({ rule_id, severity, messages }));
      if (args.flagged_only === true && flag_ids.length === 0) continue;
      rows.push({ account_id: m.account_id, roles: m.roles, ...key, flags });
    }
  }
  return { target: report.target, chain: report.chain, ruleset_version: report.ruleset_version, total: rows.length, keys: rows, errors };
}

/** The DAO's proposals, newest first, with votes and who is still to vote. Reads RPC only. */
export function listProposals(
  args: TargetArgs & { limit?: number; offset?: number },
  env: Env,
): Promise<ListProposalsResult & { target: string; network: Network }> {
  const t = resolve(args, env);
  return listDaoProposals(t.id, {
    network: t.network,
    ...(t.rpcUrl && { rpcUrl: t.rpcUrl }),
    ...(args.limit !== undefined && { limit: args.limit }),
    ...(args.offset !== undefined && { offset: args.offset }),
  }).then((r) => ({ target: t.id, network: t.network, ...r }));
}
