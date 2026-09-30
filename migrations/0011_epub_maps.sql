-- Redacted EPUB structure per linked book: tags, ids, and text lengths, but no
-- readable text. Lets BookFusion positions resolve without re-downloading the book.
CREATE TABLE epub_maps (
  user_id      INTEGER NOT NULL REFERENCES users(id),
  connector_id TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  map          BLOB NOT NULL,           -- gzipped JSON [[path, base64 bytes | null], ...]
  used_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, connector_id, external_id)
);
