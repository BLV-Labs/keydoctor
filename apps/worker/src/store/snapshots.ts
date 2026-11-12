// Baseline snapshots (§8.7). Writes happen only in the daily job, the first subscription,
// and compare (only when no baseline exists yet).
import type { KdReport, Network } from "key-doctor";
import type { D1Database } from "../env.ts";

export async function latestSnapshot(db: D1Database, target: string, network: Network): Promise<KdReport | null> {
  const row = await db
    .prepare(
      "SELECT report_json FROM snapshots WHERE target = ? AND network = ? ORDER BY block_height DESC, generated_at DESC LIMIT 1",
    )
    .bind(target, network)
    .first<{ report_json: string }>();
  return row === null ? null : (JSON.parse(row.report_json) as KdReport);
}

export async function saveSnapshot(db: D1Database, report: KdReport): Promise<void> {
  await db
    .prepare(
      "INSERT OR REPLACE INTO snapshots (target, network, generated_at, block_height, report_json) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(report.target.id, report.chain.network, report.generated_at, report.chain.block_height, JSON.stringify(report))
    .run();
}

/**
 * Most targets that may hold a baseline with no chat watching them (red-team M9). The first compare or /changes of a
 * target stores a baseline, and /mcp is open, so without a bound a loop over made-up names fills D1. Past it, the
 * oldest unwatched baselines go first: a caller can push out another unwatched baseline, which only resets that
 * target's next compare, but never a watched one (the daily job and its alerts diff against those).
 */
export const MAX_UNWATCHED_BASELINES = 500;

const UNWATCHED = `SELECT target, network, MIN(generated_at) AS first FROM snapshots s WHERE NOT EXISTS (
  SELECT 1 FROM subscriptions u WHERE u.target = s.target AND u.network = s.network) GROUP BY target, network`;

/** Deletes the oldest unwatched baselines until one more fits under MAX_UNWATCHED_BASELINES. */
export async function makeRoomForBaseline(db: D1Database): Promise<void> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM (${UNWATCHED})`).first<{ n: number }>();
  const over = (row?.n ?? 0) - MAX_UNWATCHED_BASELINES + 1;
  if (over <= 0) return;
  await db
    .prepare(`DELETE FROM snapshots WHERE (target, network) IN (SELECT target, network FROM (${UNWATCHED}) ORDER BY first, target LIMIT ?)`)
    .bind(over)
    .run();
}

/** Keeps the newest `keep` snapshots of a target. */
export async function pruneSnapshots(db: D1Database, target: string, network: Network, keep = 7): Promise<void> {
  await db
    .prepare(
      `DELETE FROM snapshots WHERE target = ? AND network = ? AND generated_at NOT IN (
         SELECT generated_at FROM snapshots WHERE target = ? AND network = ? ORDER BY block_height DESC, generated_at DESC LIMIT ?)`,
    )
    .bind(target, network, target, network, keep)
    .run();
}
