-- Mafia BCN database schema (Cloudflare D1 / SQLite)

-- People. "nickname" is the only thing shown publicly.
CREATE TABLE players (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name  TEXT,
  last_name   TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden', 'merged')),
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Login identities. One player can have several (Telegram, Google...).
-- The admin can pre-fill telegram username/email; provider_uid is filled on first login.
CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id     INTEGER REFERENCES players(id) ON DELETE SET NULL,
  provider      TEXT NOT NULL CHECK (provider IN ('telegram', 'google')),
  provider_uid  TEXT,
  username      TEXT,
  email         TEXT,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
  status        TEXT NOT NULL DEFAULT 'linked' CHECK (status IN ('linked', 'pending', 'rejected')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  UNIQUE (provider, provider_uid)
);
CREATE INDEX accounts_player ON accounts(player_id);

-- One row per game. winner: 'town' (citizens, incl. sheriff/doctor/maniac) or 'mafia'.
CREATE TABLE games (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,               -- YYYY-MM-DD
  number      INTEGER NOT NULL,            -- game number within the day
  winner      TEXT CHECK (winner IN ('town', 'mafia')),
  notes       TEXT,
  source      TEXT NOT NULL DEFAULT 'app', -- 'xls' (imported) | 'app'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (date, number)
);

-- Who sat where, with which role, and whether they were alive at the end.
CREATE TABLE game_seats (
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seat       INTEGER NOT NULL,
  player_id  INTEGER REFERENCES players(id),
  role       TEXT CHECK (role IN ('citizen', 'sheriff', 'doctor', 'maniac', 'mafia', 'don')),
  alive      INTEGER,                      -- 1/0 at the end of the game
  fouls      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, seat)
);
CREATE INDEX game_seats_player ON game_seats(player_id);

-- Day nominations: who started the vote, against whom, how many votes the target got.
CREATE TABLE nominations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  round        INTEGER NOT NULL,
  position     INTEGER NOT NULL,
  by_seat      INTEGER,
  target_seat  INTEGER NOT NULL,
  votes        INTEGER
);
CREATE INDEX nominations_game ON nominations(game_id, round);

-- Everything else that happens to a seat in a round (day or night).
CREATE TABLE round_events (
  game_id  INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  round    INTEGER NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('eliminated', 'removed', 'mafia_kill', 'don_check',
                                         'sheriff_check', 'maniac_kill', 'doctor_heal')),
  seat     INTEGER NOT NULL,
  PRIMARY KEY (game_id, round, kind, seat)
);
