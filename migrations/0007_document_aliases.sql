-- Manual document merges. Two devices can hash the same book differently
-- (KOReader binary partial-MD5 vs CrossPoint filename MD5), so the same book
-- shows up as two document keys that never share progress. A merge records
-- alias -> canonical here; progress reads/writes resolve the alias first.
CREATE TABLE document_aliases (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  alias      TEXT NOT NULL,   -- document hash a device sends
  document   TEXT NOT NULL,   -- canonical document hash it maps to
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, alias)
);
CREATE INDEX idx_document_aliases_doc ON document_aliases(user_id, document);
