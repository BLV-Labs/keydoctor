-- YD2 (docs/stories/epics/yield/plan.md §2): the last validated model order per DAO, as kd.yield_advice.v1 JSON.
-- One row per DAO, replaced on each new model answer. Open /mcp and later /yield calls serve this row while it still
-- fits the report (adviceFresh), so they do not spend the NEAR AI key. Only model answers are stored, never the
-- rule-order fallback. Only the Worker writes this table; it never touches snapshots or subscriptions.
CREATE TABLE yield_advice (
  target TEXT NOT NULL,
  network TEXT NOT NULL,
  advice_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (target, network)
);
