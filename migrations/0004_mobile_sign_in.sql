ALTER TABLE chat_oauth_states ADD COLUMN mobile_challenge TEXT;
ALTER TABLE chat_oauth_states ADD COLUMN mobile_state TEXT;
ALTER TABLE chat_oauth_states ADD COLUMN return_path TEXT;

CREATE TABLE chat_mobile_codes (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX chat_mobile_codes_expiry ON chat_mobile_codes(expires_at);
