-- Red-team M5: who asked for each pending code, so one client cannot fill the global live-code cap alone.
-- `client` is a hash of the caller's address (IPv6 cut to its /64), never the address itself. NULL when the request had
-- no cf-connecting-ip (local dev). Only the Worker writes this table.
ALTER TABLE pending_subscriptions ADD COLUMN client TEXT;
CREATE INDEX pending_by_client ON pending_subscriptions (client, expires_at);
