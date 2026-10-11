ALTER TABLE chat_messages
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'morse'));
