-- A user's own OAuth client id for a connector (e.g. a developer app they
-- registered themselves), kept with the per-account reveal. NULL = the server's.
ALTER TABLE connector_reveals ADD COLUMN client_id TEXT;
