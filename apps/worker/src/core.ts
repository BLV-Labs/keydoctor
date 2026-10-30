// Shared functions behind the MCP tools and the bot commands (§8.2, §8.3).
import { diffReports, resolveTarget, scanTarget, toSummary, type KdDiff, type KdReport, type KdReportSummary, type Network } from "key-doctor";
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
