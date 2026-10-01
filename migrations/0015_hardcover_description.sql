-- Book description from Hardcover's catalog (served on its own, not in the list).
ALTER TABLE documents ADD COLUMN description TEXT;

-- Books looked up before this were cached without a description: drop those
-- lookups (keep series lists) so the background job fetches each book once more.
DELETE FROM catalog_cache WHERE key NOT LIKE 'series:%';
UPDATE documents SET hc_checked_at = NULL WHERE hc_checked_at IS NOT NULL;
