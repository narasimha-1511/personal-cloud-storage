-- Photo grids used to load the full original for every tile — a 5 MB, 12 MP
-- file painted into a 110px square. Each image now gets a small WebP derivative
-- generated on first view and cached in object storage next to the original.
--
-- thumb_state is NULL until generation has been attempted:
--   PENDING     — queued or in flight
--   READY       — thumb_key holds a usable derivative
--   UNSUPPORTED — the codec cannot be decoded (HEIC, some RAW); serve the original
--   FAILED      — generation errored; retried on a later view
ALTER TABLE videos ADD COLUMN thumb_key TEXT;
ALTER TABLE videos ADD COLUMN thumb_state TEXT;
