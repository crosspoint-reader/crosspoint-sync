-- Titles with a leading series number ("241 - Title") were matched on the number alone,
-- so their covers, page counts, book details and automatic service matches may be wrong
-- or missing. Look those books up again, as a title change does: a cover or page count
-- the user set stays, and so do details and matches they picked.
CREATE TEMP TABLE series_number_docs AS
  SELECT user_id, document FROM (
    SELECT user_id, document,
           ltrim(title, '0123456789') AS rest,
           length(title) - length(ltrim(title, '0123456789')) AS digits
    FROM documents WHERE title IS NOT NULL
  )
  WHERE digits BETWEEN 1 AND 3
    AND substr(rest, 1, 3) IN (' - ', ' – ', ' — ')
    AND length(trim(substr(rest, 4))) > 0;

UPDATE documents SET cover_checked_at = NULL, hc_checked_at = NULL
  WHERE (user_id, document) IN (SELECT user_id, document FROM series_number_docs);

DELETE FROM connector_matches
  WHERE source IN ('auto', 'none')
    AND (user_id, document) IN (SELECT user_id, document FROM series_number_docs);

DROP TABLE series_number_docs;
