-- Retain source events so repeated uploads and KOReader cloud-synced copies deduplicate.
CREATE TABLE reader_history_pages (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document TEXT NOT NULL,
  page INTEGER NOT NULL CHECK(page >= 0),
  total_pages INTEGER NOT NULL CHECK(total_pages > 0 AND total_pages <= 1000000 AND page <= total_pages),
  start_time INTEGER NOT NULL CHECK(start_time >= 946684800 AND start_time <= 4102444799),
  duration INTEGER NOT NULL CHECK(duration >= 0 AND duration <= 86400),
  PRIMARY KEY (user_id, document, page, total_pages, start_time)
);
