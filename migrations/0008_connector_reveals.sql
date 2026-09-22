-- Per-user reveal of stealth connectors (Kindle): hidden from the connector list
-- until the user opts in via the /kindle landing page (or links, which implies reveal).

CREATE TABLE connector_reveals (
  user_id       INTEGER NOT NULL REFERENCES users(id),
  connector_id  TEXT NOT NULL,
  revealed_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, connector_id)
);
