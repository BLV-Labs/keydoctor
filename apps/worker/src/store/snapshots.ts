// Baseline snapshots (§8.7). Writes happen only in the daily job, the first subscription,
// and compare with update_baseline (or with no baseline yet).
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
