ALTER TABLE comments ADD COLUMN parent_id TEXT;

CREATE INDEX IF NOT EXISTS comments_parent_created
ON comments (parent_id, created_at);
