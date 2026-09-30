-- progress_log only began with 0012, which seeded one row per book from the
-- latest position, so everything read before then collapsed onto one day.
-- progress_samples has kept a timestamped (percentage, time) point per 0.1% of
-- each book since 0006: backfill the log with every sample older than the
-- book's first logged row, so earlier reading days and pages come back.
INSERT INTO progress_log (user_id, document, device_id, percentage, at)
  SELECT s.user_id, s.document, 'history', s.percentage, s.updated_at
  FROM progress_samples s
  WHERE s.updated_at < COALESCE(
    (SELECT MIN(l.at) FROM progress_log l WHERE l.user_id = s.user_id AND l.document = s.document),
    9223372036854775807
  );
