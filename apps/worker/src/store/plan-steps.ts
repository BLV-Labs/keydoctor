import type { PlanStepRecord } from "key-doctor";
import type { D1Database } from "../env.ts";

/** Enough for every step still in the Guard's newest requests. */
const STEPS_READ = 200;

/** Takes the lease in one statement, so two cycles cannot both win. Returns the Guard cursor, or null when held. */
export async function acquireLease(db: D1Database, now: string, until: string): Promise<number | null> {
  const row = await db
    .prepare(
      `INSERT INTO keeper_state (id, lease_until, guard_cursor) VALUES (1, ?, 0)
       ON CONFLICT(id) DO UPDATE SET lease_until = excluded.lease_until WHERE keeper_state.lease_until <= ?
       RETURNING guard_cursor`,
    )
    .bind(until, now)
    .first<{ guard_cursor: number }>();
  return row?.guard_cursor ?? null;
}

export async function releaseLease(db: D1Database, now: string, cursor: number): Promise<void> {
  await db.prepare("UPDATE keeper_state SET lease_until = ?, guard_cursor = ? WHERE id = 1").bind(now, cursor).run();
}

export async function saveStep(db: D1Database, guardId: string, step: PlanStepRecord & { tx_hash: string }): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO plan_steps (tx_hash, guard_id, plan_id, run, due, status, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(step.tx_hash, guardId, step.plan_id, step.run, step.due, step.status, JSON.stringify(step), step.executed_at)
    .run();
}

/** Oldest first. */
export async function stepsFor(db: D1Database, guardId: string): Promise<PlanStepRecord[]> {
  const { results } = await db
    .prepare("SELECT result_json FROM plan_steps WHERE guard_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .bind(guardId, STEPS_READ)
    .all<{ result_json: string }>();
  return results.map((r) => JSON.parse(r.result_json) as PlanStepRecord).reverse();
}
