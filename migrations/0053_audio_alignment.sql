-- Word-level ebook <-> audiobook alignment: which audio millisecond reads which
-- character of the EPUB. Built by forced alignment (ASR + anchored matching) so
-- a reading position resolves to an audio time exactly, instead of linearly.
CREATE TABLE audio_alignment (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  connector_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  document    TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  -- gzip(JSON [[charOffset, ms], ...]), ascending in both, offsets in UTF-16 units.
  samples     BLOB NOT NULL,
  -- gzip(JSON [spineLength, ...]) so a global offset maps back to a spine index.
  spines      BLOB NOT NULL,
  words       INTEGER NOT NULL,
  coverage    REAL NOT NULL,
  source      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, connector_id, external_id)
);

-- One alignment attempt per matched book. Serialized by the align worker; a
-- failure retries with backoff rather than blocking the queue.
CREATE TABLE audio_align_jobs (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  connector_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  document    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL,
  last_error  TEXT,
  files_done  INTEGER NOT NULL DEFAULT 0,
  files_total INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, connector_id, external_id)
);

CREATE INDEX audio_align_jobs_ready ON audio_align_jobs (status, next_try_at);
