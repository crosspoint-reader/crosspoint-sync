-- User-set reading status (NULL = derive from progress) and a cached cover URL
-- resolved from title/author. cover_checked_at throttles retries after a miss.
ALTER TABLE documents ADD COLUMN status TEXT;
ALTER TABLE documents ADD COLUMN status_at INTEGER;
ALTER TABLE documents ADD COLUMN cover_url TEXT;
ALTER TABLE documents ADD COLUMN cover_checked_at INTEGER;
