-- Red-team M8 follow-up: who subscribed a chat, so one Telegram user cannot take every chat slot of a target.
ALTER TABLE subscriptions ADD COLUMN added_by TEXT;
CREATE INDEX subscriptions_by_user ON subscriptions (target, network, added_by);
