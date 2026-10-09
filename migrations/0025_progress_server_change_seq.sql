-- Server-side merges and winner changes must reach even the device that
-- originally wrote the selected position. Keep this marker across later writes
-- so self-exclusion cannot hide an unconsumed server-side change.
ALTER TABLE progress ADD COLUMN server_change_seq INTEGER NOT NULL DEFAULT 0;
