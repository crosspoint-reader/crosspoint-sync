-- Per-match push condition surfaced in the review UI (e.g. Hardcover has no
-- edition with a page count, so progress can't sync). NULL = no known issue.
ALTER TABLE connector_matches ADD COLUMN push_note TEXT;
