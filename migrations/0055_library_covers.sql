-- Covers from the user's own library (LIBRARY_OPDS_URL). The library's cover links
-- usually need its login, so each cover is fetched once and served from here.
CREATE TABLE library_covers (
  id TEXT PRIMARY KEY,          -- random: the cover's public address
  source TEXT NOT NULL UNIQUE,  -- the library's cover link
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- A cover picked by hand is kept; the library replaces only automatic ones. Covers stored
-- before this can't be told apart and count as automatic.
ALTER TABLE documents ADD COLUMN cover_manual INTEGER NOT NULL DEFAULT 0;
-- When the library last answered for the book, and whether it had it (a miss is asked again).
ALTER TABLE documents ADD COLUMN library_checked_at INTEGER;
ALTER TABLE documents ADD COLUMN library_match INTEGER NOT NULL DEFAULT 0;
