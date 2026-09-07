-- Folder-only accounts: a scoped user sees nothing except the folders they
-- have been granted in folder_access (grants now matter independently of a
-- folder's restricted flag).
ALTER TABLE users ADD COLUMN scoped INTEGER NOT NULL DEFAULT 0;
