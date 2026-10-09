-- Change feed cursor for GET /api/v1/progress/changes. updated_at can't be the
-- cursor: fan-in stores the external service's timestamp, so a position
-- imported today can carry yesterday's updated_at. Every progress write stamps
-- the next value of this single counter instead.
CREATE TABLE change_seq (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
ALTER TABLE progress ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
-- Existing rows get distinct non-zero values so a device's cursor moves past
-- them after its first since=0 snapshot instead of replaying them every sync.
UPDATE progress SET change_seq = rowid;
INSERT INTO change_seq (id, value) VALUES (1, COALESCE((SELECT MAX(change_seq) FROM progress), 0));
CREATE INDEX idx_progress_change_seq ON progress(user_id, change_seq);
