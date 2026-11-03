-- SearchAPI (paid) page lookups now run from stats only, once per book per 90
-- days. pages_checked_at is when this document last asked.
ALTER TABLE documents ADD COLUMN pages_checked_at INTEGER;

-- Books the old lookup already took to Amazon and missed (they were retried
-- every week): remember the miss so they aren't paid for again yet.
INSERT OR IGNORE INTO catalog_cache (key, data, checked_at)
  SELECT 'amazon:' || substr(key, 6), '{"pages":null}', checked_at FROM catalog_cache
  WHERE key LIKE 'info:%' AND data IS NOT NULL AND json_extract(data, '$.pages') IS NULL;
UPDATE documents SET pages_checked_at = cover_checked_at
  WHERE page_count IS NULL AND cover_checked_at IS NOT NULL;
