-- Multipart uploads are now created in R2 lazily (when the first part is
-- signed), so bulk-registering hundreds of files is a single fast DB write.
-- SQLite cannot drop NOT NULL in place: rebuild the table.

CREATE TABLE uploads_new (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  r2_upload_id TEXT,
  part_size INTEGER NOT NULL,
  total_parts INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'ABORTED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO uploads_new SELECT id, video_id, r2_upload_id, part_size, total_parts, status, created_at, updated_at FROM uploads;

DROP TABLE uploads;
ALTER TABLE uploads_new RENAME TO uploads;
CREATE INDEX uploads_video_idx ON uploads(video_id, status);
