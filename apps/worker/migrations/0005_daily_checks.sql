-- Red-team H3: the daily key diff runs hourly and checks a few targets per run, the ones whose last attempt is oldest
-- (never attempted first). One row per watched target, replaced before each scan, so a failing target goes to the back
-- instead of holding the front. Only the Worker writes this table.
CREATE TABLE daily_checks (
  target TEXT NOT NULL,
  network TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (target, network)
);
