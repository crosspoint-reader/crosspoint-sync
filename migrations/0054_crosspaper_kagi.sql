CREATE TABLE news_kagi_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  categories TEXT NOT NULL
);

CREATE TABLE news_kagi_issues (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issue TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  categories TEXT NOT NULL,
  articles TEXT NOT NULL,
  missing TEXT NOT NULL,
  PRIMARY KEY (user_id, issue)
);
CREATE INDEX idx_news_kagi_batch ON news_kagi_issues(user_id, batch_id);
