-- Yield agent (docs/stories/epics/yield/plan.md, YD3). Only the Worker writes these tables.

-- Chats that asked for yield updates. Separate from subscriptions: a chat watching a DAO's keys never gets yield
-- messages it did not ask for, and a yield watch never turns on key alerts.
CREATE TABLE yield_watches (
  target TEXT NOT NULL,
  network TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chat_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (target, network, chat_id)
);

-- The top suggestion last pushed per DAO (shouldPushYield compares against it). NULL top_id: no suggestion.
CREATE TABLE yield_state (
  target TEXT NOT NULL,
  network TEXT NOT NULL,
  top_id TEXT,
  top_apr REAL,
  pushed_at TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (target, network)
);
