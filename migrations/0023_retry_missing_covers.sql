-- Cover lookups used to search only the US Apple Books store and drop non-Latin
-- characters when matching, so books with Japanese, Chinese, Korean or other
-- non-Latin titles cached "no cover". Forget those misses so they're looked up again.
UPDATE documents SET cover_checked_at = NULL WHERE cover_url IS NULL;
