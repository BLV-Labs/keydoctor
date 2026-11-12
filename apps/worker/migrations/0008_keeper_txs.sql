-- Red-team M2: keeper transactions per Guard per UTC day. Anyone can make a Guard with a plan due every minute, and
-- the keeper pays the gas, so each Guard gets a daily share. Rows older than today are deleted as the keeper writes.
CREATE TABLE keeper_txs (
  guard_id TEXT NOT NULL,
  day TEXT NOT NULL, -- YYYY-MM-DD, UTC
  txs INTEGER NOT NULL,
  PRIMARY KEY (guard_id, day)
);
