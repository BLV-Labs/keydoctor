// pending_subscriptions (§8.7): one-time codes behind the /start deep links (UC5, P1).
import type { Network } from "key-doctor";
import type { D1Database } from "../env.ts";

export interface Pending {
  target: string;
  network: Network;
}

export async function addPending(db: D1Database, token: string, p: Pending, now: Date, ttlMinutes: number): Promise<string> {
  const expires = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  await db.prepare("DELETE FROM pending_subscriptions WHERE expires_at < ?").bind(now.toISOString()).run();
  await db
    .prepare("INSERT INTO pending_subscriptions (token, target, network, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(token, p.target, p.network, now.toISOString(), expires)
    .run();
  return expires;
}

export async function countLivePending(db: D1Database, now: Date): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM pending_subscriptions WHERE expires_at >= ?").bind(now.toISOString()).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Returns the pending target and deletes the code, or null when it is unknown or expired. */
export async function takePending(db: D1Database, token: string, now: Date): Promise<Pending | null> {
  const row = await db
    .prepare("SELECT target, network, expires_at FROM pending_subscriptions WHERE token = ?")
    .bind(token)
    .first<{ target: string; network: Network; expires_at: string }>();
  if (row === null) return null;
  await db.prepare("DELETE FROM pending_subscriptions WHERE token = ?").bind(token).run();
  return row.expires_at >= now.toISOString() ? { target: row.target, network: row.network } : null;
}
