-- Covers from the user's own library (LIBRARY_OPDS_URL). The library's cover links
-- usually need its login, so each cover is fetched once and served from here.
CREATE TABLE library_covers (
  id TEXT PRIMARY KEY,          -- random: the cover's public address
  source TEXT NOT NULL,         -- the catalog (a hash of its URL and login) and the cover link
  digest TEXT NOT NULL,         -- SHA-256 of the image: a changed picture is a new row and address
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  fetched_at INTEGER NOT NULL,
  UNIQUE (source, digest)
);

-- A cover picked by hand is kept; the library replaces only automatic ones. Covers stored
-- before this can't be told apart and count as automatic.
ALTER TABLE documents ADD COLUMN cover_manual INTEGER NOT NULL DEFAULT 0;
-- The cover came from the user's library (stored here, or a link on another host): it goes when the
-- library drops it or the book's title or author is changed.
ALTER TABLE documents ADD COLUMN cover_library INTEGER NOT NULL DEFAULT 0;
-- When the library last answered for the book, and whether it had it (a miss is asked again).
ALTER TABLE documents ADD COLUMN library_checked_at INTEGER;
ALTER TABLE documents ADD COLUMN library_match INTEGER NOT NULL DEFAULT 0;
-- Which details came from the user's library, as ",description,genres,series,release_year," (kept out
-- of the catalog export), whatever the library answers later.
ALTER TABLE documents ADD COLUMN library_fields TEXT;
