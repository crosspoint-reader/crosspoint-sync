-- Percentage-only services (Spotify, Audiobookshelf, Kindle) used to borrow the
-- nearest real reader position however far it was. A reader then saw its own old
-- location and reported "already synced" (e.g. Spotify 56.9% carrying the reader's
-- 47.1% location). Rows whose borrowed location sits more than SAMPLE_REACH (0.5%)
-- from their percentage go back to the percentage alone; nearby ones stay.
UPDATE progress
SET progress = device_id || ':' || CAST(ROUND(percentage * 1000000) AS INTEGER)
WHERE device_id IN ('spotify', 'audiobookshelf', 'kindle')
  AND progress LIKE '/body/%'
  AND NOT EXISTS (
    SELECT 1 FROM progress_samples s
    WHERE s.user_id = progress.user_id AND s.document = progress.document
      AND s.progress = progress.progress
      AND ABS(s.percentage - progress.percentage) <= 0.005
  );
