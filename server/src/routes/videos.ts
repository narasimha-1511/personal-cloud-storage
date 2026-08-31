import { Hono } from 'hono';
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { SignedUrlResponse } from '@videovault/shared';
import type { Db } from '../db/index.js';
import { folders, users, videos } from '../db/schema.js';
import type { R2Client } from '../r2.js';
import type { AuthVariables } from '../auth/middleware.js';
import type { Env } from '../env.js';
import { log } from '../log.js';
import { toVideoInfo } from './uploads.js';
import { canSeeVideo, visibleVideosCondition } from '../access.js';
import { deleteVideoStorage } from './projects.js';

export interface VideoRouteDeps {
  db: Db;
  env: Env;
  r2: R2Client | null;
}

export function videoRoutes({ db, env, r2 }: VideoRouteDeps) {
  const app = new Hono<{ Variables: AuthVariables }>();

  async function loadVideo(id: string) {
    const rows = await db
      .select({ video: videos, ownerUsername: users.username })
      .from(videos)
      .innerJoin(users, eq(videos.ownerId, users.id))
      .where(eq(videos.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  function canModify(c: { get(k: 'user'): AuthVariables['user'] }, ownerId: string): boolean {
    const user = c.get('user');
    return user.role === 'admin' || user.id === ownerId;
  }

  app.get('/', async (c) => {
    const projectId = c.req.query('projectId');
    const folderId = c.req.query('folderId');
    const status = c.req.query('status');

    const conditions: SQL[] = [];
    const visibility = visibleVideosCondition(c.get('user'));
    if (visibility) conditions.push(visibility);
    if (projectId) conditions.push(eq(videos.projectId, projectId));
    if (folderId === 'none') conditions.push(isNull(videos.folderId));
    else if (folderId) conditions.push(eq(videos.folderId, folderId));
    if (status && ['UPLOADING', 'READY', 'ABORTED', 'FAILED'].includes(status)) {
      conditions.push(eq(videos.status, status as 'READY'));
    }

    const rows = await db
      .select({ video: videos, ownerUsername: users.username })
      .from(videos)
      .innerJoin(users, eq(videos.ownerId, users.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(videos.createdAt));
    return c.json({ videos: rows.map((r) => toVideoInfo(r.video, r.ownerUsername)) });
  });

  app.get('/:id', async (c) => {
    const row = await loadVideo(c.req.param('id'));
    if (!row || !(await canSeeVideo(db, c.get('user'), row.video))) {
      return c.json({ error: 'Video not found' }, 404);
    }
    return c.json({ video: toVideoInfo(row.video, row.ownerUsername) });
  });

  app.post('/:id/set-hidden', async (c) => {
    const body = z.object({ hidden: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid request' }, 400);
    const row = await loadVideo(c.req.param('id'));
    if (!row) return c.json({ error: 'Video not found' }, 404);
    if (!canModify(c, row.video.ownerId)) return c.json({ error: 'Forbidden' }, 403);
    await db
      .update(videos)
      .set({ hidden: body.data.hidden, updatedAt: new Date().toISOString() })
      .where(eq(videos.id, row.video.id));
    log({ op: 'video.set_hidden', ok: true, videoId: row.video.id, userId: c.get('user').id, hidden: body.data.hidden });
    return c.json({ ok: true });
  });

  for (const [path, disposition] of [
    ['/:id/view-url', 'inline'],
    ['/:id/download-url', 'attachment'],
  ] as const) {
    app.post(path, async (c) => {
      if (!r2) return c.json({ error: 'Object storage is not configured' }, 503);
      const row = await loadVideo(c.req.param('id'));
      if (!row || !(await canSeeVideo(db, c.get('user'), row.video))) {
        return c.json({ error: 'Video not found' }, 404);
      }
      if (row.video.status !== 'READY') {
        return c.json({ error: `Video is not ready (status: ${row.video.status})` }, 409);
      }
      const ttl = env.VIEW_URL_TTL_SECONDS;
      const url = await r2.signGetUrl(row.video.objectKey, ttl, {
        filename: row.video.displayName,
        disposition,
      });
      log({
        op: disposition === 'inline' ? 'video.view_url' : 'video.download_url',
        ok: true,
        videoId: row.video.id,
        userId: c.get('user').id,
      });
      return c.json({
        url,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      } satisfies SignedUrlResponse);
    });
  }

  app.post('/:id/rename', async (c) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(256) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Name is required' }, 400);
    const row = await loadVideo(c.req.param('id'));
    if (!row) return c.json({ error: 'Video not found' }, 404);
    if (!canModify(c, row.video.ownerId)) return c.json({ error: 'Forbidden' }, 403);
    // Display name only — the object key is immutable identity.
    await db
      .update(videos)
      .set({ displayName: body.data.name, updatedAt: new Date().toISOString() })
      .where(eq(videos.id, row.video.id));
    return c.json({ ok: true });
  });

  app.post('/:id/move', async (c) => {
    const body = z
      .object({ folderId: z.string().min(1).nullable() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid request' }, 400);
    const row = await loadVideo(c.req.param('id'));
    if (!row) return c.json({ error: 'Video not found' }, 404);
    if (!canModify(c, row.video.ownerId)) return c.json({ error: 'Forbidden' }, 403);
    if (body.data.folderId) {
      const folder = (
        await db
          .select()
          .from(folders)
          .where(and(eq(folders.id, body.data.folderId), eq(folders.projectId, row.video.projectId)))
      )[0];
      if (!folder) return c.json({ error: 'Folder not found in this project' }, 404);
    }
    // Metadata move only; the object key stays where it is.
    await db
      .update(videos)
      .set({ folderId: body.data.folderId, updatedAt: new Date().toISOString() })
      .where(eq(videos.id, row.video.id));
    return c.json({ ok: true });
  });

  app.post('/:id/delete', async (c) => {
    const row = await loadVideo(c.req.param('id'));
    if (!row) return c.json({ error: 'Video not found' }, 404);
    if (!canModify(c, row.video.ownerId)) return c.json({ error: 'Forbidden' }, 403);
    await deleteVideoStorage(db, r2, row.video);
    await db.delete(videos).where(eq(videos.id, row.video.id));
    log({ op: 'video.delete', ok: true, videoId: row.video.id, userId: c.get('user').id });
    return c.json({ ok: true });
  });

  return app;
}
