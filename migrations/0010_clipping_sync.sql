ALTER TABLE clippings ADD COLUMN layout_signature INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clippings ADD COLUMN start_offset INTEGER;
ALTER TABLE clippings ADD COLUMN end_offset INTEGER;
ALTER TABLE clippings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
UPDATE clippings SET revision = rowid;
CREATE TABLE clipping_sync_clock (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
INSERT INTO clipping_sync_clock SELECT 1, COALESCE(MAX(revision), 0) FROM clippings;
CREATE INDEX idx_clippings_revision ON clippings(user_id, document, revision);
