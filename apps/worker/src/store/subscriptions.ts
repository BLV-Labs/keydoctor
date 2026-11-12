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

/** A chat that blocked or removed the bot loses its key subscriptions and its yield watches (one subrequest). */
export async function deleteChat(db: D1Database, chatId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM subscriptions WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM yield_watches WHERE chat_id = ?").bind(chatId),
  ]);
}

/** Chats one target may have (red-team M8): every chat costs one subrequest per alert. */
export const MAX_CHATS_PER_TARGET = 25;

export async function countChatsFor(db: D1Database, target: string, network: Network): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE target = ? AND network = ?").bind(target, network).first<{ n: number }>();
  return row?.n ?? 0;
}

/** The oldest MAX_CHATS_PER_TARGET chats watching the target: fan-out per alert stays bounded. */
export async function chatsFor(db: D1Database, target: string, network: Network): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT chat_id FROM subscriptions WHERE target = ? AND network = ? ORDER BY created_at, chat_id LIMIT ?")
    .bind(target, network, MAX_CHATS_PER_TARGET)
    .all<{ chat_id: string }>();
  return results.map((r) => r.chat_id);
}

/** A group upgraded to a supergroup gets a new chat id; its subscriptions and yield watches follow it. */
export async function moveChat(db: D1Database, from: string, to: string): Promise<void> {
  await db.batch(
    ["subscriptions", "yield_watches"].flatMap((table) => [
      db.prepare(`UPDATE OR IGNORE ${table} SET chat_id = ?, chat_type = 'supergroup' WHERE chat_id = ?`).bind(to, from),
      db.prepare(`DELETE FROM ${table} WHERE chat_id = ?`).bind(from),
    ]),
  );
}
