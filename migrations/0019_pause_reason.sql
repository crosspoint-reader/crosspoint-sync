-- Who paused a book: 'manual' (status button) or 'auto' (no progress for
-- AUTO_PAUSE_DAYS). NULL whenever status isn't 'paused'.
ALTER TABLE documents ADD COLUMN pause_reason TEXT;
