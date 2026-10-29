// Only the Worker writes subscriptions (§8.7). Primary key (target, network, chat_id) blocks duplicates.
import type { Network } from "key-doctor";
import type { D1Database } from "../env.ts";

export interface Subscription {
  target: string;
  network: Network;
  target_type: "dao" | "account";
  chat_id: string;
  chat_type: string;
  created_at: string;
}

/** Returns false when this chat already watches the target. */
export async function addSubscription(db: D1Database, s: Subscription): Promise<boolean> {
  const existing = await db
    .prepare("SELECT 1 AS x FROM subscriptions WHERE target = ? AND network = ? AND chat_id = ?")
    .bind(s.target, s.network, s.chat_id)
    .first();
  if (existing !== null) return false;
  await db
    .prepare(
      "INSERT OR IGNORE INTO subscriptions (target, network, target_type, chat_id, chat_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(s.target, s.network, s.target_type, s.chat_id, s.chat_type, s.created_at)
    .run();
  return true;
}

/** Returns false when there was nothing to remove. */
export async function removeSubscription(db: D1Database, target: string, network: Network, chatId: string): Promise<boolean> {
  const existing = await db
    .prepare("SELECT 1 AS x FROM subscriptions WHERE target = ? AND network = ? AND chat_id = ?")
    .bind(target, network, chatId)
    .first();
  if (existing === null) return false;
  await db.prepare("DELETE FROM subscriptions WHERE target = ? AND network = ? AND chat_id = ?").bind(target, network, chatId).run();
  return true;
}

export async function listSubscriptions(db: D1Database, chatId: string): Promise<Subscription[]> {
  const { results } = await db
    .prepare("SELECT * FROM subscriptions WHERE chat_id = ? ORDER BY created_at, target")
    .bind(chatId)
    .all<Subscription>();
  return results;
}

export async function countSubscriptions(db: D1Database, chatId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE chat_id = ?").bind(chatId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function deleteChat(db: D1Database, chatId: string): Promise<void> {
  await db.prepare("DELETE FROM subscriptions WHERE chat_id = ?").bind(chatId).run();
}

export async function chatsFor(db: D1Database, target: string, network: Network): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT chat_id FROM subscriptions WHERE target = ? AND network = ? ORDER BY created_at")
    .bind(target, network)
    .all<{ chat_id: string }>();
  return results.map((r) => r.chat_id);
}
