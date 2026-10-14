ALTER TABLE chat_conversations ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
  CHECK (visibility IN ('private', 'public'));
CREATE INDEX chat_public_groups ON chat_conversations(visibility, type, created_at);

CREATE TABLE chat_group_requests (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, user_id)
);
CREATE INDEX chat_group_requests_group ON chat_group_requests(conversation_id, created_at);

CREATE TABLE chat_group_removals (
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TRIGGER chat_group_member_limit BEFORE INSERT ON chat_members
WHEN EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = NEW.conversation_id AND c.type = 'group')
  AND NOT EXISTS (SELECT 1 FROM chat_members m WHERE m.conversation_id = NEW.conversation_id AND m.user_id = NEW.user_id)
  AND (SELECT COUNT(*) FROM chat_members m WHERE m.conversation_id = NEW.conversation_id) >= 100
BEGIN
  SELECT RAISE(ABORT, 'group_member_limit');
END;
