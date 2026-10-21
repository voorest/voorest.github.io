-- Player = short name used at the table ("Tania") + public nick ("Tianaboa").
-- The admin picks players by "name nick"; public rankings show the nick only.
ALTER TABLE players ADD COLUMN name TEXT;
-- Avatar (stored in KV as avatar:<player id>): version for cache-busting and where it came from.
ALTER TABLE players ADD COLUMN avatar_v INTEGER;
ALTER TABLE players ADD COLUMN avatar_src TEXT;
