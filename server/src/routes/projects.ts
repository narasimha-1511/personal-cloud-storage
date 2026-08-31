import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { FolderInfo, ProjectInfo } from '@videovault/shared';
import type { Db } from '../db/index.js';
import { folderAccess, folders, projects, uploads, users, videos } from '../db/schema.js';
import type { R2Client } from '../r2.js';
import { slugify } from '../keys.js';
import { requireAdmin, type AuthVariables } from '../auth/middleware.js';
import { canSeeFolder } from '../access.js';
import { log } from '../log.js';

const nameSchema = z.object({ name: z.string().trim().min(1).max(128) });
const deleteSchema = z.object({ force: z.boolean().optional() });

export interface ProjectRouteDeps {
  db: Db;
  r2: R2Client | null;
}

/** Deletes a video's bytes in R2 (final object and/or live multipart). Best-effort. */
export async function deleteVideoStorage(
  db: Db,
  r2: R2Client | null,
  video: { id: string; objectKey: string },
): Promise<void> {
  if (!r2) return;
  const live = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.videoId, video.id), eq(uploads.status, 'IN_PROGRESS')));
  for (const u of live) {
    if (u.r2UploadId) {
      await r2.abortMultipartUpload(video.objectKey, u.r2UploadId).catch(() => {});
    }
  }
  await r2.deleteObject(video.objectKey).catch(() => {});
}

export function projectRoutes({ db, r2 }: ProjectRouteDeps) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get('/', async (c) => {
    // NOTE: the correlated references must be written as literal
    // `projects.id` — interpolating the drizzle column renders an
    // unqualified "id" which the subquery resolves against ITS OWN table,
    // silently making every count zero.
    const rows = await db
      .select({
        project: projects,
        videoCount: sql<number>`(SELECT COUNT(*) FROM videos v WHERE v.project_id = projects.id AND v.status != 'ABORTED')`,
        folderCount: sql<number>`(SELECT COUNT(*) FROM folders f WHERE f.project_id = projects.id)`,
      })
      .from(projects)
      .orderBy(projects.createdAt);
    const out: ProjectInfo[] = rows.map((r) => ({
      id: r.project.id,
      slug: r.project.slug,
      name: r.project.name,
      createdAt: r.project.createdAt,
      videoCount: r.videoCount,
      folderCount: r.folderCount,
    }));
    return c.json({ projects: out });
  });

  app.post('/', requireAdmin, async (c) => {
    const body = nameSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Name is required' }, 400);
    const slug = slugify(body.data.name);
    const dup = await db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug));
    if (dup.length > 0) return c.json({ error: `A project with the slug "${slug}" already exists` }, 409);
    const row = { id: ulid(), slug, name: body.data.name, createdAt: new Date().toISOString() };
    await db.insert(projects).values(row);
    log({ op: 'project.create', ok: true, projectId: row.id, userId: c.get('user').id });
    return c.json(
      { project: { ...row, videoCount: 0, folderCount: 0 } satisfies ProjectInfo },
      201,
    );
  });

  app.post('/:id/rename', requireAdmin, async (c) => {
    const body = nameSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Name is required' }, 400);
    const result = await db
      .update(projects)
      .set({ name: body.data.name })
      .where(eq(projects.id, c.req.param('id')));
    if (result.changes === 0) return c.json({ error: 'Project not found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/:id/delete', requireAdmin, async (c) => {
    const body = deleteSchema.safeParse(await c.req.json().catch(() => ({})));
    const force = body.success && body.data.force === true;
    const id = c.req.param('id');
    const project = (await db.select().from(projects).where(eq(projects.id, id)))[0];
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const vids = await db.select().from(videos).where(eq(videos.projectId, id));
    if (vids.length > 0 && !force) {
      return c.json(
        { error: `Project contains ${vids.length} video(s). Pass force to delete them permanently.`, videoCount: vids.length },
        409,
      );
    }
    for (const v of vids) {
      await deleteVideoStorage(db, r2, v);
      await db.delete(videos).where(eq(videos.id, v.id));
    }
    await db.delete(projects).where(eq(projects.id, id));
    log({ op: 'project.delete', ok: true, projectId: id, userId: c.get('user').id, deletedVideos: vids.length });
    return c.json({ ok: true });
  });

  app.get('/:id/folders', async (c) => {
    const projectId = c.req.param('id');
    const user = c.get('user');
    const rows = await db
      .select({
        folder: folders,
        createdByUsername: users.username,
        // Literal `folders.id` on purpose — see the note in the project list.
        videoCount: sql<number>`(SELECT COUNT(*) FROM videos v WHERE v.folder_id = folders.id AND v.status != 'ABORTED')`,
      })
      .from(folders)
      .leftJoin(users, eq(folders.createdBy, users.id))
      .where(eq(folders.projectId, projectId))
      .orderBy(folders.createdAt);

    const visible: typeof rows = [];
    for (const r of rows) {
      if (await canSeeFolder(db, user, r.folder)) visible.push(r);
    }

    // Admins also get the member list of restricted folders.
    let membersByFolder = new Map<string, string[]>();
    if (user.role === 'admin' && visible.some((r) => r.folder.restricted)) {
      const access = await db
        .select()
        .from(folderAccess)
        .where(inArray(folderAccess.folderId, visible.map((r) => r.folder.id)));
      membersByFolder = access.reduce((m, a) => {
        m.set(a.folderId, [...(m.get(a.folderId) ?? []), a.userId]);
        return m;
      }, new Map<string, string[]>());
    }

    const out: FolderInfo[] = visible.map((r) => ({
      id: r.folder.id,
      projectId: r.folder.projectId,
      slug: r.folder.slug,
      name: r.folder.name,
      createdAt: r.folder.createdAt,
      createdByUsername: r.createdByUsername,
      videoCount: r.videoCount,
      restricted: r.folder.restricted,
      ...(user.role === 'admin' ? { memberIds: membersByFolder.get(r.folder.id) ?? [] } : {}),
    }));
    return c.json({ folders: out });
  });

  app.post('/:id/folders', async (c) => {
    const body = nameSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Name is required' }, 400);
    const projectId = c.req.param('id');
    const project = (await db.select().from(projects).where(eq(projects.id, projectId)))[0];
    if (!project) return c.json({ error: 'Project not found' }, 404);
    const slug = slugify(body.data.name);
    const dup = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.projectId, projectId), eq(folders.slug, slug)));
    if (dup.length > 0) return c.json({ error: `A folder "${slug}" already exists in this project` }, 409);
    const user = c.get('user');
    const row = {
      id: ulid(),
      projectId,
      slug,
      name: body.data.name,
      restricted: false,
      createdBy: user.id,
      createdAt: new Date().toISOString(),
    };
    await db.insert(folders).values(row);
    log({ op: 'folder.create', ok: true, projectId, folderId: row.id, userId: user.id });
    return c.json(
      { folder: { ...row, createdByUsername: user.username, videoCount: 0, memberIds: [] } satisfies FolderInfo },
      201,
    );
  });

  return app;
}

/** Routes addressed by folder id (rename/delete). */
export function folderRoutes({ db, r2 }: ProjectRouteDeps) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.post('/:id/rename', requireAdmin, async (c) => {
    const body = nameSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Name is required' }, 400);
    const result = await db
      .update(folders)
      .set({ name: body.data.name })
      .where(eq(folders.id, c.req.param('id')));
    if (result.changes === 0) return c.json({ error: 'Folder not found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/:id/access', requireAdmin, async (c) => {
    const body = z
      .object({ restricted: z.boolean(), userIds: z.array(z.string().min(1)).max(200) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid request' }, 400);
    const id = c.req.param('id');
    const folder = (await db.select().from(folders).where(eq(folders.id, id)))[0];
    if (!folder) return c.json({ error: 'Folder not found' }, 404);

    await db.update(folders).set({ restricted: body.data.restricted }).where(eq(folders.id, id));
    await db.delete(folderAccess).where(eq(folderAccess.folderId, id));
    if (body.data.restricted && body.data.userIds.length > 0) {
      const unique = [...new Set(body.data.userIds)];
      await db.insert(folderAccess).values(unique.map((userId) => ({ folderId: id, userId })));
    }
    log({
      op: 'folder.set_access',
      ok: true,
      folderId: id,
      userId: c.get('user').id,
      restricted: body.data.restricted,
      members: body.data.userIds.length,
    });
    return c.json({ ok: true });
  });

  app.post('/:id/delete', requireAdmin, async (c) => {
    const body = deleteSchema.safeParse(await c.req.json().catch(() => ({})));
    const force = body.success && body.data.force === true;
    const id = c.req.param('id');
    const folder = (await db.select().from(folders).where(eq(folders.id, id)))[0];
    if (!folder) return c.json({ error: 'Folder not found' }, 404);

    const vids = await db.select().from(videos).where(eq(videos.folderId, id));
    if (vids.length > 0 && !force) {
      return c.json(
        { error: `Folder contains ${vids.length} video(s). Pass force to delete them permanently.`, videoCount: vids.length },
        409,
      );
    }
    for (const v of vids) {
      await deleteVideoStorage(db, r2, v);
      await db.delete(videos).where(eq(videos.id, v.id));
    }
    await db.delete(folders).where(eq(folders.id, id));
    log({ op: 'folder.delete', ok: true, folderId: id, userId: c.get('user').id, deletedVideos: vids.length });
    return c.json({ ok: true });
  });

  return app;
}
