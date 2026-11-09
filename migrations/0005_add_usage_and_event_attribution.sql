ALTER TABLE interest_events ADD COLUMN visitor_id TEXT REFERENCES visitors(visitor_id);

CREATE INDEX IF NOT EXISTS idx_interest_events_visitor_event
  ON interest_events(visitor_id, event_type);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  reserved_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_reserved_at
  ON ai_usage(reserved_at);

CREATE INDEX IF NOT EXISTS idx_ai_usage_chat_reserved_at
  ON ai_usage(chat_id, reserved_at);

CREATE TABLE IF NOT EXISTS provider_cooldowns (
  provider TEXT PRIMARY KEY,
  retry_after INTEGER NOT NULL DEFAULT 0
);
