-- Covers from the user's own library (LIBRARY_OPDS_URL). The library's cover links
-- usually need its login, so each cover is fetched once and served from here.
CREATE TABLE library_covers (
  id TEXT PRIMARY KEY,          -- random: the cover's public address
  source TEXT NOT NULL UNIQUE,  -- the library's cover link
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  fetched_at INTEGER NOT NULL
);
