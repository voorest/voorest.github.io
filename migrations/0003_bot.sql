-- Telegram bot: chats the bot knows (private chats = people who pressed Start; groups it was added to)
CREATE TABLE bot_chats (
  chat_id     TEXT PRIMARY KEY,
  type        TEXT NOT NULL,                     -- private | group | supergroup | channel
  title       TEXT,                              -- group title or person's name
  username    TEXT,
  status      TEXT NOT NULL DEFAULT 'active',    -- active | blocked (user stopped/blocked the bot) | left (removed from group)
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What the admin sent through the bot (history on the Bot page)
CREATE TABLE bot_posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL DEFAULT 'announcement',  -- announcement | game | update
  audience    TEXT NOT NULL,                         -- group | subscribers | admins
  text        TEXT NOT NULL,
  game_id     INTEGER,
  created_by  INTEGER,                               -- accounts.id
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at   TEXT,
  deleted_at  TEXT
);

-- One row per delivered message (needed to edit/delete it later)
CREATE TABLE bot_post_messages (
  post_id     INTEGER NOT NULL REFERENCES bot_posts(id) ON DELETE CASCADE,
  chat_id     TEXT NOT NULL,
  message_id  INTEGER,
  state       TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed | pending_edit | pending_delete | deleted
  error       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (post_id, chat_id)
);
CREATE INDEX bot_post_messages_state ON bot_post_messages(state);
