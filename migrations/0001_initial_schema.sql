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
  email TEXT
);

CREATE TABLE IF NOT EXISTS bot_state (
  chat_id INTEGER PRIMARY KEY,
  step TEXT NOT NULL DEFAULT 'idle',
  answers TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
