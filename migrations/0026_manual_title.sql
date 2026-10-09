-- Title and author the user corrected by hand (book page, "Edit title & author").
-- Device syncs keep sending their own; while this is set they don't overwrite it.
ALTER TABLE documents ADD COLUMN meta_manual INTEGER NOT NULL DEFAULT 0;
