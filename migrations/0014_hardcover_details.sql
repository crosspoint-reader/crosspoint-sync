-- Book details from Hardcover's catalog (moods, genres, series, rating...), looked
-- up server-side with the operator's HARDCOVER_API_KEY. List fields are JSON arrays.
ALTER TABLE documents ADD COLUMN hc_id TEXT;
ALTER TABLE documents ADD COLUMN hc_slug TEXT;
ALTER TABLE documents ADD COLUMN moods TEXT;
ALTER TABLE documents ADD COLUMN genres TEXT;
ALTER TABLE documents ADD COLUMN content_warnings TEXT;
ALTER TABLE documents ADD COLUMN rating REAL;
ALTER TABLE documents ADD COLUMN series TEXT;
ALTER TABLE documents ADD COLUMN series_position REAL;
ALTER TABLE documents ADD COLUMN hc_series_id INTEGER;
ALTER TABLE documents ADD COLUMN release_year INTEGER;
ALTER TABLE documents ADD COLUMN hc_checked_at INTEGER;

-- One lookup per book across all users: keyed by normalized title|author.
-- data is the matched book as JSON, or NULL for a miss (retried later).
CREATE TABLE catalog_cache (
  key        TEXT PRIMARY KEY,
  data       TEXT,
  checked_at INTEGER NOT NULL
);
