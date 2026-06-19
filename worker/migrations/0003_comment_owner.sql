ALTER TABLE comments ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS comments_post_parent_created
ON comments (post_id, parent_id, created_at);
