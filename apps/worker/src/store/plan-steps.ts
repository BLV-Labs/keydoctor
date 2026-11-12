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

/** Frees the lease and, in the same subrequest, adds the cycle's keeper transactions (`addKeeperTxs`). */
export async function releaseLease(db: D1Database, now: string, cursor: number, txs?: { day: string; sent: Map<string, number> }): Promise<void> {
  const release = db.prepare("UPDATE keeper_state SET lease_until = ?, guard_cursor = ? WHERE id = 1").bind(now, cursor);
  if (!txs || txs.sent.size === 0) {
    await release.run();
    return;
  }
  await db.batch([release, ...keeperTxsStatements(db, txs.day, txs.sent)]);
}

/** Keeper transactions sent for the Guards of each of `daoIds` on `day` (red-team M2). One subrequest. */
export async function keeperTxsOn(db: D1Database, day: string, daoIds: string[]): Promise<Map<string, number>> {
  if (daoIds.length === 0) return new Map();
  const { results } = await db
    .prepare(`SELECT dao_id, txs FROM keeper_txs WHERE day = ? AND dao_id IN (${daoIds.map(() => "?").join(", ")})`)
    .bind(day, ...daoIds)
    .all<{ dao_id: string; txs: number }>();
  return new Map(results.map((r) => [r.dao_id, r.txs]));
}

/** Adds a cycle's transactions and drops earlier days. */
function keeperTxsStatements(db: D1Database, day: string, sent: Map<string, number>) {
  return [
    db.prepare("DELETE FROM keeper_txs WHERE day < ?").bind(day),
    ...[...sent].map(([dao, n]) =>
      db
        .prepare("INSERT INTO keeper_txs (dao_id, day, txs) VALUES (?, ?, ?) ON CONFLICT(dao_id, day) DO UPDATE SET txs = txs + excluded.txs")
        .bind(dao, day, n),
    ),
  ];
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
