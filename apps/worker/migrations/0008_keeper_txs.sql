-- Red-team M2: keeper transactions per DAO per UTC day. Anyone can make a Guard with a plan due every minute, and
-- the keeper pays the gas, so each DAO gets a daily share, which all of its Guards draw on. Rows older than today are deleted as the keeper writes.
CREATE TABLE keeper_txs (
  dao_id TEXT NOT NULL,
  day TEXT NOT NULL, -- YYYY-MM-DD, UTC
  txs INTEGER NOT NULL,
  PRIMARY KEY (dao_id, day)
);
