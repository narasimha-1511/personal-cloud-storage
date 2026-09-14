-- View-only accounts: can browse and play, but cannot download, upload, or
-- modify anything. Enforced server-side on every mutating/download path.
ALTER TABLE users ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
