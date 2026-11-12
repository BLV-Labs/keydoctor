// Shared functions behind the MCP tools and the bot commands (§8.2, §8.3).
import {
  KdErrorException,
  diffReports,
  isKdError,
  preflightUnread,
  preflightVerdict,
  listProposals as listDaoProposals,
  resolveTarget,
  scanTarget,
  scanVault,
  toSummary,
  type KdYieldReport,
  type Flag,
  type KdDiff,
  type KdPreflight,
  type KdReport,
  type KdReportSummary,
  type KeyInfo,
  type ListProposalsResult,
  type Network,
} from "key-doctor";
import type { Env } from "./env.ts";
import { kdErrorBody } from "./http.ts";
import { latestSnapshot, saveSnapshot } from "./store/snapshots.ts";

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

/** kd.yield.v1 for one DAO, rule-ordered. Reads RPC only: no model, no D1. Throws NOT_A_DAO for an account. */
export function scanYield(args: TargetArgs, env: Env): Promise<KdYieldReport> {
  const t = resolve(args, env);
  const mainnet = rpcUrlsFor(env, "mainnet");
  return scanVault(t.id, { network: t.network, ...(t.rpcUrl && { rpcUrl: t.rpcUrl }), ...(mainnet && { mainnetRpcUrl: mainnet }) });
}

/** The council's key status, or null when it could not be read (risk unknown, not low). */
export async function councilStatus(args: TargetArgs, env: Env): Promise<KdReport["summary"] | null> {
  try {
    return (await scan(args, env)).summary;
  } catch {
    return null;
  }
}

/**
 * The yield report plus the council's key status (YD3): a proposal is only as safe as the council that votes on it.
 * Bot `/yield` and MCP `yield_suggestions` both call this, so they return the same report. Never touches D1.
 */
export async function yieldCheck(args: TargetArgs, env: Env): Promise<{ report: KdYieldReport; council: KdReport["summary"] | null }> {
  const report = await scanYield(args, env);
  return { report, council: await councilStatus({ target: report.dao, network: report.chain.network }, env) };
}

/** UC2: never reads or writes D1. */
export async function diagnose(
  args: TargetArgs & { detail?: "summary" | "full" },
  env: Env,
): Promise<KdReport | KdReportSummary> {
  const report = await scan(args, env);
  return args.detail === "full" ? report : toSummary(report);
}

/** Scan failures that leave the risk unknown: preflight answers review, not an error the agent may skip past. */
const UNREAD_CODES = new Set<string>(["RPC_ERROR", "RATE_LIMITED", "LIMIT_EXCEEDED"]);

/** Agent pre-flight: kd.preflight.v1 for one account. Never reads or writes D1. A DAO is refused: an agent pays from an account. */
export async function preflight(args: TargetArgs, env: Env): Promise<KdPreflight> {
  const t = resolve(args, env);
  let report: KdReport;
  try {
    report = await scanTarget(t.id, { network: t.network, ...(t.rpcUrl && { rpcUrl: t.rpcUrl }) });
  } catch (e) {
    if (isKdError(e) && UNREAD_CODES.has(e.kd.code)) return preflightUnread(t.id, t.network, e.kd.code);
    throw e;
  }
  if (report.target.type === "dao") {
    throw new KdErrorException(
      kdErrorBody("INVALID_TARGET", {
        vi: "preflight chỉ kiểm tra một account. Với DAO, hãy dùng diagnose.",
        en: "preflight checks one account. For a DAO, use diagnose.",
      }),
    );
  }
  return preflightVerdict(report);
}

/**
 * UC3: compares a fresh scan with the stored baseline. It stores a baseline only when there is none yet and never
 * moves an existing one: the daily job diffs against the same baseline, so a caller who could move it (the open
 * /mcp has no auth) could add a key and then hide it from the daily "key added" alert.
 */
export async function compare(args: TargetArgs, env: Env): Promise<KdDiff> {
  const t = resolve(args, env);
  const baseline = await latestSnapshot(env.DB, t.id, t.network);
  const curr = await scan(args, env);
  const diff = diffReports(baseline, curr);
  if (baseline === null) {
    await saveSnapshot(env.DB, curr);
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
