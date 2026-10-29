-- docs/final-idea.md §8.7. Only the Worker writes these tables.
CREATE TABLE snapshots (
  target TEXT NOT NULL,
  network TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  block_height INTEGER NOT NULL,
  report_json TEXT NOT NULL,
  PRIMARY KEY (target, network, generated_at)
);

CREATE TABLE subscriptions (
  target TEXT NOT NULL,
  network TEXT NOT NULL,
  target_type TEXT NOT NULL, -- 'dao' | 'account'
  chat_id TEXT NOT NULL,
  chat_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (target, network, chat_id)
);

CREATE TABLE pending_subscriptions (
  token TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  network TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE proposal_state (
  target TEXT NOT NULL,
  network TEXT NOT NULL,
  last_proposal_id INTEGER NOT NULL,
  pending_json TEXT NOT NULL, -- ProposalWatchState.pending
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target, network)
);

CREATE TABLE alerts_sent (
  alert_id TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL,
  alert_json TEXT NOT NULL
);
