CREATE TABLE chat_lesson_progress (
  user_id TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  curriculum TEXT NOT NULL,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 18),
  best_score INTEGER NOT NULL CHECK (best_score BETWEEN 0 AND 100),
  completed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, curriculum, level)
);
