-- TaxRefund Bot: demand tracking + bot chat state
CREATE TABLE IF NOT EXISTS visitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  visitor_id TEXT UNIQUE NOT NULL,
  referrer TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS interest_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  referrer TEXT,
  user_agent TEXT,
  email TEXT,
  event_type TEXT NOT NULL DEFAULT 'free_complete',
  traffic_type TEXT NOT NULL DEFAULT 'external_unknown',
  visitor_id TEXT REFERENCES visitors(visitor_id)
);

CREATE TABLE IF NOT EXISTS bot_state (
  chat_id INTEGER PRIMARY KEY,
  step TEXT NOT NULL DEFAULT 'idle',
  answers TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_interest_events_visitor_event
  ON interest_events(visitor_id, event_type);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  visitor_id TEXT REFERENCES visitors(visitor_id),
  reserved_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_reserved_at
  ON ai_usage(reserved_at);

CREATE INDEX IF NOT EXISTS idx_ai_usage_chat_reserved_at
  ON ai_usage(chat_id, reserved_at);

CREATE INDEX IF NOT EXISTS idx_ai_usage_visitor_reserved_at
  ON ai_usage(visitor_id, reserved_at);

CREATE TABLE IF NOT EXISTS provider_cooldowns (
  provider TEXT PRIMARY KEY,
  retry_after INTEGER NOT NULL DEFAULT 0
);
