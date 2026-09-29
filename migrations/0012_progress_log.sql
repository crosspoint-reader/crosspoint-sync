-- One row per progress change (any device, any source). Stock CrossPoint and
-- KOReader never send reading stats, so pages/books activity is derived from
-- this history plus a print page count. Seeded with each device's current
-- position so existing books get a first data point.
CREATE TABLE progress_log (
  user_id    INTEGER NOT NULL,
  document   TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  percentage REAL NOT NULL,
  at         INTEGER NOT NULL
);
CREATE INDEX idx_progress_log ON progress_log(user_id, document, at);
INSERT INTO progress_log (user_id, document, device_id, percentage, at)
  SELECT user_id, document, device_id, percentage, updated_at FROM progress;

-- Print-edition page count, resolved with the cover. Clear the miss throttle
-- so books with a cached cover get their page count looked up once.
ALTER TABLE documents ADD COLUMN page_count INTEGER;
UPDATE documents SET cover_checked_at = NULL;
