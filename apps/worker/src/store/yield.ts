// Yield watches, the last pushed top suggestion (migrations/0003_yield.sql) and the cached model advice (0004). Only the Worker writes these.
import type { KdYieldAdvice, Network } from "key-doctor";
import type { D1Database } from "../env.ts";

export interface YieldTop {
  id: string;
  apr: number;
}

/** Returns false when this chat already watches the DAO's yield. */
export async function addYieldWatch(db: D1Database, target: string, network: Network, chatId: string, chatType: string): Promise<boolean> {
  const existing = await db
    .prepare("SELECT 1 AS x FROM yield_watches WHERE target = ? AND network = ? AND chat_id = ?")
    .bind(target, network, chatId)
    .first();
  if (existing !== null) return false;
  await db
    .prepare("INSERT OR IGNORE INTO yield_watches (target, network, chat_id, chat_type, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(target, network, chatId, chatType, new Date().toISOString())
    .run();
  return true;
}

/** Returns false when there was nothing to remove. */
export async function removeYieldWatch(db: D1Database, target: string, network: Network, chatId: string): Promise<boolean> {
  const existing = await db
    .prepare("SELECT 1 AS x FROM yield_watches WHERE target = ? AND network = ? AND chat_id = ?")
    .bind(target, network, chatId)
    .first();
  if (existing === null) return false;
  await db.prepare("DELETE FROM yield_watches WHERE target = ? AND network = ? AND chat_id = ?").bind(target, network, chatId).run();
  return true;
}

export async function countYieldWatches(db: D1Database, chatId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM yield_watches WHERE chat_id = ?").bind(chatId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function yieldChatsFor(db: D1Database, target: string, network: Network): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT chat_id FROM yield_watches WHERE target = ? AND network = ? ORDER BY created_at")
    .bind(target, network)
    .all<{ chat_id: string }>();
  return results.map((r) => r.chat_id);
}

/** Watched DAOs, the least recently checked first (never checked first of all). */
export async function watchedYieldDaos(db: D1Database, limit: number): Promise<{ target: string; network: Network }[]> {
  const { results } = await db
    .prepare(
      `SELECT w.target AS target, w.network AS network, MAX(s.checked_at) AS checked
       FROM yield_watches w LEFT JOIN yield_state s ON s.target = w.target AND s.network = w.network
       GROUP BY w.target, w.network
       ORDER BY checked IS NOT NULL, checked, w.target
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ target: string; network: Network }>();
  return results;
}

/** undefined: never recorded. null inside: recorded with no suggestion. */
export async function getYieldTop(db: D1Database, target: string, network: Network): Promise<{ top: YieldTop | null } | undefined> {
  const row = await db
    .prepare("SELECT top_id, top_apr FROM yield_state WHERE target = ? AND network = ?")
    .bind(target, network)
    .first<{ top_id: string | null; top_apr: number | null }>();
  if (row === null) return undefined;
  return { top: row.top_id === null || row.top_apr === null ? null : { id: row.top_id, apr: row.top_apr } };
}

/** Records `top` as the last pushed (or first seen) suggestion. */
export async function saveYieldTop(db: D1Database, target: string, network: Network, top: YieldTop | null): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare("INSERT OR REPLACE INTO yield_state (target, network, top_id, top_apr, pushed_at, checked_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(target, network, top?.id ?? null, top?.apr ?? null, now, now)
    .run();
}

/** Moves only checked_at, so the round-robin goes on without changing what was last pushed. */
export async function touchYieldChecked(db: D1Database, target: string, network: Network): Promise<void> {
  await db
    .prepare("UPDATE yield_state SET checked_at = ? WHERE target = ? AND network = ?")
    .bind(new Date().toISOString(), target, network)
    .run();
}

/** The cached model advice for a DAO, or null. A row that does not parse as kd.yield_advice.v1 counts as none. */
export async function getYieldAdvice(db: D1Database, target: string, network: Network): Promise<KdYieldAdvice | null> {
  const row = await db
    .prepare("SELECT advice_json FROM yield_advice WHERE target = ? AND network = ?")
    .bind(target, network)
    .first<{ advice_json: string }>();
  if (row === null) return null;
  try {
    const advice = JSON.parse(row.advice_json) as KdYieldAdvice;
    return advice?.schema_version === "kd.yield_advice.v1" ? advice : null;
  } catch {
    return null;
  }
}

/** Replaces the DAO's cached advice. Callers store model answers only (plan §2). */
export async function saveYieldAdvice(db: D1Database, advice: KdYieldAdvice): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO yield_advice (target, network, advice_json, created_at) VALUES (?, ?, ?, ?)")
    .bind(advice.dao, advice.network, JSON.stringify(advice), advice.generated_at)
    .run();
}
