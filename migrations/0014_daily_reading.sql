-- Cumulative local calendar-day counters; independent of book aliases and old totals.
CREATE TABLE stats_device_day (
  user_id INTEGER NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL,
  date TEXT NOT NULL,
  seconds INTEGER NOT NULL CHECK(seconds >= 0 AND seconds <= 4294967295),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id, date)
);
