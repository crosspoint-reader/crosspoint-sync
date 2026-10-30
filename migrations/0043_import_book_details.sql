-- Imported edition identity and the reader's own rating, separate from catalog ratings.
ALTER TABLE documents ADD COLUMN isbn TEXT;
ALTER TABLE documents ADD COLUMN user_rating REAL;
