-- Per-user download tracking: the editor can see which files they have not
-- taken yet ("NEW" badge and the "New for you" filter). A row means this
-- user has downloaded (or explicitly marked) this file.

CREATE TABLE video_downloads (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  downloaded_at TEXT NOT NULL,
  PRIMARY KEY (video_id, user_id)
);
CREATE INDEX idx_video_downloads_user ON video_downloads(user_id);
