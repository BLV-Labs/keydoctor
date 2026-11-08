-- Keeper (ADR 0005, GĐ29).

-- One row. The lease stops two cycles overlapping; the cursor is where the next cycle reads the factory's Guards.
CREATE TABLE keeper_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lease_until TEXT NOT NULL,
  guard_cursor INTEGER NOT NULL
);

-- One row per keeper transaction that changed a plan. §8.7 keys this by (plan_id, run), but plan ids repeat across
-- Guards and one run can take several transactions (a skip keeps the run), so the key is the transaction.
CREATE TABLE plan_steps (
  tx_hash TEXT PRIMARY KEY,
  guard_id TEXT NOT NULL,
  plan_id INTEGER NOT NULL,
  run INTEGER NOT NULL,
  due TEXT NOT NULL, -- the slot, nanoseconds
  status TEXT NOT NULL, -- PlanStepResult.status
  result_json TEXT NOT NULL, -- PlanStepResult
  created_at TEXT NOT NULL
);
CREATE INDEX plan_steps_guard ON plan_steps (guard_id, created_at);
