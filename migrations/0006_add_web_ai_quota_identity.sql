ALTER TABLE ai_usage ADD COLUMN visitor_id TEXT REFERENCES visitors(visitor_id);

CREATE INDEX IF NOT EXISTS idx_ai_usage_visitor_reserved_at
  ON ai_usage(visitor_id, reserved_at);
