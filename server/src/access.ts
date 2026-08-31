import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { folderAccess, folders, videos } from './db/schema.js';
import type { SessionUser } from './auth/sessions.js';

/**
 * Visibility rules, enforced server-side on every read path:
 * - admins see everything;
 * - a hidden video is visible only to its owner;
 * - a video inside a restricted folder is visible only to granted users.
 */

/** WHERE fragment for video list queries (no-op for admins). */
export function visibleVideosCondition(user: SessionUser): SQL | undefined {
  if (user.role === 'admin') return undefined;
  return sql`(
    (videos.hidden = 0 OR videos.owner_id = ${user.id})
    AND (
      videos.folder_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM folders f
        WHERE f.id = videos.folder_id AND f.restricted = 1
          AND NOT EXISTS (SELECT 1 FROM folder_access fa WHERE fa.folder_id = f.id AND fa.user_id = ${user.id})
      )
    )
  )`;
}

export async function canSeeFolder(
  db: Db,
  user: SessionUser,
  folder: { restricted: boolean; id: string },
): Promise<boolean> {
  if (user.role === 'admin' || !folder.restricted) return true;
  const rows = await db
    .select({ userId: folderAccess.userId })
    .from(folderAccess)
    .where(and(eq(folderAccess.folderId, folder.id), eq(folderAccess.userId, user.id)))
    .limit(1);
  return rows.length > 0;
}

export async function canSeeVideo(
  db: Db,
  user: SessionUser,
  video: { hidden: boolean; ownerId: string; folderId: string | null },
): Promise<boolean> {
  if (user.role === 'admin') return true;
  if (video.hidden && video.ownerId !== user.id) return false;
  if (!video.folderId) return true;
  const folder = (await db.select().from(folders).where(eq(folders.id, video.folderId)).limit(1))[0];
  if (!folder) return true;
  return canSeeFolder(db, user, folder);
}

/** Convenience filter shared by count-style queries; keeps callers honest. */
export async function filterVisibleVideos<T extends { hidden: boolean; ownerId: string; folderId: string | null }>(
  db: Db,
  user: SessionUser,
  rows: T[],
): Promise<T[]> {
  if (user.role === 'admin') return rows;
  const out: T[] = [];
  for (const row of rows) {
    if (await canSeeVideo(db, user, row)) out.push(row);
  }
  return out;
}

export { videos };
