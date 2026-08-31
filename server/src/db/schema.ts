import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'user'] }).notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    // HMAC of the random token handed to the browser; the raw token is never stored.
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ expiresIdx: index('sessions_expires_idx').on(t.expiresAt) }),
);

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const folders = sqliteTable(
  'folders',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ projectSlugIdx: uniqueIndex('folders_project_slug_idx').on(t.projectId, t.slug) }),
);

export const videos = sqliteTable(
  'videos',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    folderId: text('folder_id').references(() => folders.id),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    objectKey: text('object_key').notNull().unique(),
    originalFilename: text('original_filename').notNull(),
    displayName: text('display_name').notNull(),
    size: integer('size').notNull(),
    mimeType: text('mime_type').notNull(),
    status: text('status', { enum: ['UPLOADING', 'READY', 'ABORTED', 'FAILED'] }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    projectFolderIdx: index('videos_project_folder_idx').on(t.projectId, t.folderId, t.status),
    statusIdx: index('videos_status_idx').on(t.status),
  }),
);

export const uploads = sqliteTable(
  'uploads',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    r2UploadId: text('r2_upload_id').notNull(),
    partSize: integer('part_size').notNull(),
    totalParts: integer('total_parts').notNull(),
    status: text('status', { enum: ['IN_PROGRESS', 'COMPLETED', 'ABORTED'] }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ videoIdx: index('uploads_video_idx').on(t.videoId, t.status) }),
);

export const uploadParts = sqliteTable(
  'upload_parts',
  {
    uploadId: text('upload_id')
      .notNull()
      .references(() => uploads.id, { onDelete: 'cascade' }),
    partNumber: integer('part_number').notNull(),
    etag: text('etag'),
    size: integer('size'),
    status: text('status', { enum: ['PENDING', 'UPLOADED'] }).notNull(),
    uploadedAt: text('uploaded_at'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.uploadId, t.partNumber] }) }),
);
