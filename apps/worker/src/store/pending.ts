// pending_subscriptions (§8.7): one-time codes behind the /start deep links (UC5, P1).
import type { Network } from "key-doctor";
import type { D1Database } from "../env.ts";

export interface Pending {
  target: string;
  network: Network;
}

export async function addPending(db: D1Database, token: string, p: Pending, now: Date, ttlMinutes: number, client: string | null = null): Promise<string> {
  const expires = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  await db.prepare("DELETE FROM pending_subscriptions WHERE expires_at < ?").bind(now.toISOString()).run();
  await db
    .prepare("INSERT INTO pending_subscriptions (token, target, network, created_at, expires_at, client) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(token, p.target, p.network, now.toISOString(), expires, client)
    .run();
  return expires;
}

/** Live codes in all, and the ones `client` asked for (0 when client is null). */
export async function countLivePending(db: D1Database, now: Date, client: string | null = null): Promise<{ all: number; mine: number }> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(client = ?), 0) AS mine FROM pending_subscriptions WHERE expires_at >= ?")
    .bind(client, now.toISOString())
    .first<{ n: number; mine: number }>();
  return { all: row?.n ?? 0, mine: row?.mine ?? 0 };
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
