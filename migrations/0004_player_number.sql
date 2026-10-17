-- Player number (No.) is stored separately from the id, so deleting the newest
-- player frees its number again. Existing players keep their numbers.
ALTER TABLE players ADD COLUMN number INTEGER;
UPDATE players SET number = id;
CREATE UNIQUE INDEX players_number ON players(number);
