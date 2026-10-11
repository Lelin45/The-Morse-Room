PRAGMA foreign_keys = ON;

CREATE TABLE chat_users (
  id TEXT PRIMARY KEY,
  username TEXT COLLATE NOCASE UNIQUE,
  email TEXT COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  CHECK (username IS NULL OR (length(username) BETWEEN 3 AND 24))
);
CREATE INDEX chat_users_email ON chat_users(email);

CREATE TABLE chat_identities (
  provider TEXT NOT NULL CHECK (provider = 'google'),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, subject)
);

CREATE TABLE chat_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX chat_sessions_expiry ON chat_sessions(expires_at);

CREATE TABLE chat_oauth_states (
  state_hash TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'google'),
  nonce TEXT NOT NULL,
  verifier TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX chat_oauth_states_expiry ON chat_oauth_states(expires_at);

CREATE TABLE chat_friends (
  user_low TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  user_high TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_low, user_high),
  CHECK (user_low < user_high)
);

CREATE TABLE chat_friend_requests (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  pair_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX chat_friend_requests_recipient ON chat_friend_requests(recipient_id, created_at);

CREATE TABLE chat_conversations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  name TEXT,
  dm_pair TEXT UNIQUE,
  code TEXT UNIQUE,
  owner_id TEXT NOT NULL REFERENCES chat_users(id),
  created_at INTEGER NOT NULL,
  CHECK ((type = 'direct' AND dm_pair IS NOT NULL AND code IS NULL)
    OR (type = 'group' AND dm_pair IS NULL AND code IS NOT NULL))
);

CREATE TABLE chat_members (
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX chat_members_user ON chat_members(user_id, conversation_id);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES chat_users(id),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  morse TEXT NOT NULL CHECK (length(morse) BETWEEN 1 AND 12000),
  client_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, sender_id, client_id)
);
CREATE INDEX chat_messages_conversation ON chat_messages(conversation_id, id);

CREATE TABLE chat_rate_limits (
  actor TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (actor, bucket)
);
CREATE INDEX chat_rate_limits_expiry ON chat_rate_limits(expires_at);
