-- Login sessions (cookie holds a random token; only its SHA-256 hash is stored)
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);

-- Group-wide settings edited by the admin (rating weight, title thresholds...)
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO settings (key, value) VALUES ('priorWeight', '5'), ('minGames', '3'), ('defaultSeats', '10');
