CREATE TABLE microblog_clipping_selections (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document TEXT NOT NULL,
  clipping_id TEXT NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0,
  published_snapshot TEXT,
  PRIMARY KEY (user_id, document, clipping_id)
);
CREATE TABLE microblog_clipping_posts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document TEXT NOT NULL,
  identity TEXT NOT NULL,
  url TEXT,
  fingerprint TEXT,
  attempted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  PRIMARY KEY (user_id, document)
);
