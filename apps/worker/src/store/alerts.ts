import type { D1Database } from "../env.ts";

/** D1 binds at most 100 values per query; a row takes 3. */
export const MAX_MARKS = 30;

export async function alertSent(db: D1Database, alertId: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM alerts_sent WHERE alert_id = ?").bind(alertId).first()) !== null;
}

/** The ids in `alertIds` already sent, in one query. At most 100 ids. */
export async function sentIds(db: D1Database, alertIds: readonly string[]): Promise<Set<string>> {
  if (alertIds.length === 0) return new Set();
  const { results } = await db
    .prepare(`SELECT alert_id FROM alerts_sent WHERE alert_id IN (${alertIds.map(() => "?").join(", ")})`)
    .bind(...alertIds)
    .all<{ alert_id: string }>();
  return new Set(results.map((r) => r.alert_id));
}

/** One query for up to MAX_MARKS alerts: the keeper has few subrequests to spend. */
export async function markSentMany(db: D1Database, alerts: readonly { alert_id: string }[]): Promise<void> {
  if (alerts.length === 0) return;
  const now = new Date().toISOString();
  await db
    .prepare(`INSERT OR IGNORE INTO alerts_sent (alert_id, sent_at, alert_json) VALUES ${alerts.map(() => "(?, ?, ?)").join(", ")}`)
    .bind(...alerts.flatMap((a) => [a.alert_id, now, JSON.stringify(a)]))
    .run();
}

export async function markSent(db: D1Database, alert: { alert_id: string }): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO alerts_sent (alert_id, sent_at, alert_json) VALUES (?, ?, ?)")
    .bind(alert.alert_id, new Date().toISOString(), JSON.stringify(alert))
    .run();
}

/** Forgets an alert so the same id can go out again: only for a state that ended, such as a Guard pause. */
export async function clearSent(db: D1Database, alertId: string): Promise<void> {
  await db.prepare("DELETE FROM alerts_sent WHERE alert_id = ?").bind(alertId).run();
}
