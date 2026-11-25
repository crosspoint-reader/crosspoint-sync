-- Titles were matched on the part before their first separator, so "241 - Title" and
-- "Book One - Title" were looked up as "241" and "Book One": no cover, no details, or
-- another book's. Look those books up again, as a title change does: every title with a
-- spaced dash, and colon titles that found nothing on Hardcover ("Series 6: Title").
-- A cover or page count the user set stays, and so do details and matches they picked.
CREATE TEMP TABLE separator_title_docs AS
  SELECT user_id, document FROM documents
  WHERE title IS NOT NULL
    AND (title LIKE '% - %' OR title LIKE '% – %' OR title LIKE '% — %'
         OR (hc_id IS NULL AND title LIKE '%: %'));

UPDATE documents SET cover_checked_at = NULL, hc_checked_at = NULL
  WHERE (user_id, document) IN (SELECT user_id, document FROM separator_title_docs);

DELETE FROM connector_matches
  WHERE source IN ('auto', 'none')
    AND (user_id, document) IN (SELECT user_id, document FROM separator_title_docs);

-- A colon title keeps its lookup key (the part before the colon), so its cached miss would
-- answer the new lookup without a search. Drop cached misses: they are only asked for again
-- when a book is looked up, and these are the books being looked up.
DELETE FROM catalog_cache WHERE data IS NULL;

DROP TABLE separator_title_docs;
