-- Pre-v2 CrossInk clippings arrived without a time and showed as 1 January 1970.
-- The last write is the best estimate left; new ones now get their first-sync time.
UPDATE clippings SET created_at = updated_at WHERE created_at = 0 AND deleted = 0;
