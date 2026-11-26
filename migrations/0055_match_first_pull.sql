-- Set when the pull a new match makes before its first push fails, so a retry pulls
-- again instead of pushing over a further position on the service.
ALTER TABLE connector_matches ADD COLUMN first_pull_pending INTEGER NOT NULL DEFAULT 0;
