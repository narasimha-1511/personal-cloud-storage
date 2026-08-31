-- Per-file hiding (visible only to the owner and admins) and per-folder
-- access restriction (visible only to admins and explicitly granted users).

ALTER TABLE videos ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folders ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folders ADD COLUMN created_by TEXT REFERENCES users(id);

CREATE TABLE folder_access (
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (folder_id, user_id)
);
