CREATE TABLE chat_review_users (
  user_id TEXT PRIMARY KEY REFERENCES chat_users(id) ON DELETE CASCADE
);
