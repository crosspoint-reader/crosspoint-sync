-- A connector's last-seen remote position per matched book (JSON), for services
-- whose positions carry no timestamp (Spotify resume points): a change between
-- snapshots is what dates a move. Reset whenever the match is re-saved.
ALTER TABLE connector_matches ADD COLUMN snapshot TEXT;
