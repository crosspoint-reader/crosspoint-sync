-- Keep independent counter lifetimes underneath the existing per-reader views.
-- Zero identifies counters created before reset-aware firmware existed.
CREATE TABLE stats_counter_snapshots (
  user_id INTEGER NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL,
  document TEXT NOT NULL DEFAULT '',
  counter_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id, document, counter_id)
);
CREATE TABLE stats_counter_days (
  user_id INTEGER NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL,
  document TEXT NOT NULL DEFAULT '',
  counter_id TEXT NOT NULL,
  date TEXT NOT NULL,
  seconds INTEGER NOT NULL CHECK(seconds >= 0 AND seconds <= 4294967295),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id, document, counter_id, date)
);
INSERT INTO stats_counter_snapshots
  SELECT user_id, device_id, '', '00000000000000000000000000000000', payload, updated_at FROM stats_device_global
  UNION ALL
  SELECT user_id, device_id, document, '00000000000000000000000000000000', payload, updated_at FROM stats_device_book;
INSERT INTO stats_counter_days
  SELECT user_id, device_id, '', '00000000000000000000000000000000', date, seconds, updated_at FROM stats_device_day
  UNION ALL
  SELECT user_id, device_id, document, '00000000000000000000000000000000', date, seconds, updated_at FROM stats_device_book_day;
