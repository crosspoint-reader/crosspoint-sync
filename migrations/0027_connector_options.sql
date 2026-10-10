-- Per-account connector options as JSON (e.g. Hardcover's highlights toggle and
-- journal privacy). NULL = the connector's defaults.
ALTER TABLE connector_accounts ADD COLUMN options TEXT;
