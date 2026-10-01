-- Per-merge choice of whether the alias's reading stats count toward the
-- canonical book. Stats snapshots stay keyed by the hash the device sent
-- (devices keep re-uploading cumulative totals under it), so this is applied
-- on read rather than by moving rows. Existing merges keep combining stats.
ALTER TABLE document_aliases ADD COLUMN merge_stats INTEGER NOT NULL DEFAULT 1;
