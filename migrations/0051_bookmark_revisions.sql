ALTER TABLE bookmarks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
UPDATE bookmarks SET revision = rowid;
CREATE TABLE bookmark_sync_clock (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
INSERT INTO bookmark_sync_clock SELECT 1, COALESCE(MAX(revision), 0) FROM bookmarks;
CREATE INDEX idx_bookmarks_revision ON bookmarks(user_id, document, revision);
