ALTER TABLE microblog_clipping_posts ADD COLUMN destination TEXT;
ALTER TABLE microblog_clipping_posts ADD COLUMN missing INTEGER NOT NULL DEFAULT 0;
