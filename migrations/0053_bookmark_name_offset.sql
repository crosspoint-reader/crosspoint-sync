-- User label and the pagination-independent position CrossPoint readers keep per bookmark.
ALTER TABLE bookmarks ADD COLUMN name TEXT;
ALTER TABLE bookmarks ADD COLUMN visible_offset INTEGER;
