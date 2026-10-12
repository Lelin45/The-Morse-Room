CREATE TABLE chat_blocks (
  blocker_id TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX chat_blocks_target ON chat_blocks(blocked_id, blocker_id);

CREATE TABLE chat_reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('spam', 'harassment', 'hate', 'sexual_content', 'threats', 'other')),
  details TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 1000),
  evidence_text TEXT NOT NULL,
  evidence_morse TEXT NOT NULL,
  message_kind TEXT NOT NULL CHECK (message_kind IN ('text', 'morse')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed')),
  created_at INTEGER NOT NULL,
  UNIQUE (reporter_id, message_id),
  CHECK (reporter_id <> subject_id)
);
CREATE INDEX chat_reports_pending ON chat_reports(status, created_at);
