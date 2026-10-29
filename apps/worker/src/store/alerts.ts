import type { KdAlert } from "key-doctor";
import type { D1Database } from "../env.ts";

export async function alertSent(db: D1Database, alertId: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM alerts_sent WHERE alert_id = ?").bind(alertId).first()) !== null;
}

export async function markSent(db: D1Database, alert: KdAlert): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO alerts_sent (alert_id, sent_at, alert_json) VALUES (?, ?, ?)")
    .bind(alert.alert_id, new Date().toISOString(), JSON.stringify(alert))
    .run();
}
