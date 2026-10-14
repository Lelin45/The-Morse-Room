CREATE TABLE chat_notification_devices (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES chat_sessions(token_hash) ON DELETE CASCADE,
  auth_hash TEXT NOT NULL UNIQUE,
  fcm_token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX chat_notification_devices_user ON chat_notification_devices(user_id);
CREATE TRIGGER chat_notification_device_limit BEFORE INSERT ON chat_notification_devices
WHEN (SELECT COUNT(*) FROM chat_notification_devices WHERE user_id = NEW.user_id AND id <> NEW.id) >= 8
BEGIN
  SELECT RAISE(ABORT, 'notification_device_limit');
END;
CREATE TRIGGER chat_notification_device_update_limit BEFORE UPDATE OF user_id ON chat_notification_devices
WHEN (SELECT COUNT(*) FROM chat_notification_devices WHERE user_id = NEW.user_id AND id <> NEW.id) >= 8
BEGIN
  SELECT RAISE(ABORT, 'notification_device_limit');
END;

CREATE TABLE chat_notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES chat_notification_devices(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'done', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (device_id, message_id)
);
CREATE INDEX chat_notification_outbox_pending ON chat_notification_outbox(status, next_attempt_at, lease_until);
