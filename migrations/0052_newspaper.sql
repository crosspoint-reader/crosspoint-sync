-- Personal newspaper: saved pages and RSS items, bundled into a daily EPUB.
CREATE TABLE news_feeds (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  url        TEXT NOT NULL,
  title      TEXT NOT NULL,
  fetched_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, url)
);

-- One row per article URL ever seen, so a feed item is never bundled twice.
-- content is sanitized XHTML; it is blanked once the issue ages out, leaving
-- the row as the "already seen" record.
CREATE TABLE news_articles (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  feed_id    INTEGER REFERENCES news_feeds(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL,
  byline     TEXT NOT NULL DEFAULT '',
  section    TEXT NOT NULL,
  content    TEXT NOT NULL,
  issue      TEXT, -- YYYY-MM-DD once bundled into that day's paper
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, url)
);
CREATE INDEX idx_news_articles_issue ON news_articles(user_id, issue);
