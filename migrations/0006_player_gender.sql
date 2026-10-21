-- Gender picks the default icon (man / woman) when there is no photo. NULL = not set (neutral hat).
ALTER TABLE players ADD COLUMN gender TEXT CHECK (gender IN ('m', 'f'));
