import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { z } from 'zod';
import type {
  CompleteUploadResponse,
  CreateUploadResponse,
  SignPartResponse,
  UploadStatusResponse,
  VideoInfo,
} from '@videovault/shared';
import type { Db } from '../db/index.js';
import { folders, projects, uploadParts, uploads, users, videos } from '../db/schema.js';
import type { R2Client } from '../r2.js';
import { buildObjectKey } from '../keys.js';
import type { AuthVariables } from '../auth/middleware.js';
import type { Env } from '../env.js';
import { log, logged } from '../log.js';

const MAX_PARTS = 10_000; // S3/R2 hard limit per multipart upload.

const createSchema = z.object({
  filename: z.string().min(1).max(512),
  size: z.number().int().positive(),
  mimeType: z.string().min(1).max(128),
  projectId: z.string().min(1),
  folderId: z.string().min(1).nullish(),
});

export interface UploadRouteDeps {
  db: Db;
  env: Env;
  r2: R2Client | null;
}

export function toVideoInfo(
  v: typeof videos.$inferSelect,
  ownerUsername: string,
): VideoInfo {
  return {
    id: v.id,
    projectId: v.projectId,
    folderId: v.folderId,
    ownerId: v.ownerId,
    ownerUsername,
    objectKey: v.objectKey,
    originalFilename: v.originalFilename,
    displayName: v.displayName,
    size: v.size,
    mimeType: v.mimeType,
    status: v.status,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

export function uploadRoutes({ db, env, r2 }: UploadRouteDeps) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use('*', async (c, next) => {
    if (!r2) {
      return c.json(
        { error: 'Object storage is not configured on the server (R2_* environment variables).' },
        503,
      );
    }
    await next();
  });

  /** Loads upload+video and enforces that the caller owns it or is admin. */
  async function loadOwned(c: { get(k: 'user'): AuthVariables['user'] }, uploadId: string) {
    const rows = await db
      .select({ upload: uploads, video: videos })
      .from(uploads)
      .innerJoin(videos, eq(uploads.videoId, videos.id))
      .where(eq(uploads.id, uploadId))
      .limit(1);
    const row = rows[0];
    if (!row) return { error: 'not_found' as const };
    const user = c.get('user');
    if (row.video.ownerId !== user.id && user.role !== 'admin') {
      return { error: 'forbidden' as const };
    }
    return { row };
  }

  app.post('/create', async (c) => {
    const body = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid request' }, 400);
    const { filename, size, mimeType, projectId, folderId } = body.data;
    const user = c.get('user');

    const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
    if (!project) return c.json({ error: 'Project not found' }, 404);

    let folderSlug: string | null = null;
    if (folderId) {
      const folder = (
        await db
          .select()
          .from(folders)
          .where(and(eq(folders.id, folderId), eq(folders.projectId, projectId)))
          .limit(1)
      )[0];
      if (!folder) return c.json({ error: 'Folder not found in this project' }, 404);
      folderSlug = folder.slug;
    }

    const partSize = env.PART_SIZE_BYTES;
    const totalParts = Math.max(1, Math.ceil(size / partSize));
    if (totalParts > MAX_PARTS) {
      return c.json(
        { error: `File needs ${totalParts} parts; the maximum is ${MAX_PARTS}. Increase PART_SIZE_BYTES.` },
        400,
      );
    }

    const objectKey = buildObjectKey(project.slug, folderSlug, filename);
    const now = new Date().toISOString();
    const videoId = ulid();
    const uploadId = ulid();

    const { uploadId: r2UploadId } = await logged(
      'r2.create_multipart',
      { videoId, uploadId, userId: user.id },
      () => r2!.createMultipartUpload(objectKey, mimeType),
    );

    await db.insert(videos).values({
      id: videoId,
      projectId,
      folderId: folderId ?? null,
      ownerId: user.id,
      objectKey,
      originalFilename: filename,
      displayName: filename,
      size,
      mimeType,
      status: 'UPLOADING',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(uploads).values({
      id: uploadId,
      videoId,
      r2UploadId,
      partSize,
      totalParts,
      status: 'IN_PROGRESS',
      createdAt: now,
      updatedAt: now,
    });

    log({ op: 'upload.create', ok: true, uploadId, videoId, userId: user.id, totalParts });
    return c.json(
      { uploadId, videoId, partSize, totalParts } satisfies CreateUploadResponse,
      201,
    );
  });

  app.get('/:id/status', async (c) => {
    const found = await loadOwned(c, c.req.param('id'));
    if (found.error === 'not_found') return c.json({ error: 'Upload not found' }, 404);
    if (found.error === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
    const { upload, video } = found.row;

    let uploadedParts: UploadStatusResponse['uploadedParts'] = [];
    if (upload.status === 'IN_PROGRESS') {
      uploadedParts = await logged(
        'r2.list_parts',
        { uploadId: upload.id, videoId: video.id },
        () => r2!.listParts(video.objectKey, upload.r2UploadId),
      );
    }

    return c.json({
      uploadId: upload.id,
      videoId: video.id,
      status: upload.status,
      videoStatus: video.status,
      partSize: upload.partSize,
      totalParts: upload.totalParts,
      uploadedParts,
    } satisfies UploadStatusResponse);
  });

  app.post('/:id/sign-part', async (c) => {
    const body = z
      .object({ partNumber: z.number().int().min(1) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid request' }, 400);

    const found = await loadOwned(c, c.req.param('id'));
    if (found.error === 'not_found') return c.json({ error: 'Upload not found' }, 404);
    if (found.error === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
    const { upload, video } = found.row;

    if (upload.status !== 'IN_PROGRESS') {
      return c.json({ error: `Upload is ${upload.status}` }, 409);
    }
    const { partNumber } = body.data;
    if (partNumber > upload.totalParts) {
      return c.json({ error: `partNumber must be between 1 and ${upload.totalParts}` }, 400);
    }

    const url = await r2!.signPartUrl(
      video.objectKey,
      upload.r2UploadId,
      partNumber,
      env.PART_URL_TTL_SECONDS,
    );
    const expiresAt = new Date(Date.now() + env.PART_URL_TTL_SECONDS * 1000).toISOString();

    await db
      .insert(uploadParts)
      .values({ uploadId: upload.id, partNumber, status: 'PENDING' })
      .onConflictDoNothing();

    log({ op: 'upload.sign_part', ok: true, uploadId: upload.id, videoId: video.id, partNumber });
    return c.json({ partNumber, url, expiresAt } satisfies SignPartResponse);
  });

  app.post('/:id/part-done', async (c) => {
    const body = z
      .object({
        partNumber: z.number().int().min(1),
        etag: z.string().min(1).max(256),
        size: z.number().int().positive(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid request' }, 400);

    const found = await loadOwned(c, c.req.param('id'));
    if (found.error === 'not_found') return c.json({ error: 'Upload not found' }, 404);
    if (found.error === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
    const { upload } = found.row;
    if (upload.status !== 'IN_PROGRESS') return c.json({ error: `Upload is ${upload.status}` }, 409);

    const { partNumber, etag, size } = body.data;
    const now = new Date().toISOString();
    await db
      .insert(uploadParts)
      .values({ uploadId: upload.id, partNumber, etag, size, status: 'UPLOADED', uploadedAt: now })
      .onConflictDoUpdate({
        target: [uploadParts.uploadId, uploadParts.partNumber],
        set: { etag, size, status: 'UPLOADED', uploadedAt: now },
      });
    // Keeps the stale-upload sweep from aborting an actively-progressing upload.
    await db.update(uploads).set({ updatedAt: now }).where(eq(uploads.id, upload.id));
    return c.json({ ok: true });
  });

  app.post('/:id/complete', async (c) => {
    const found = await loadOwned(c, c.req.param('id'));
    if (found.error === 'not_found') return c.json({ error: 'Upload not found' }, 404);
    if (found.error === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
    const { upload, video } = found.row;
    const user = c.get('user');

    // Idempotent: completing an already-completed upload returns the video.
    if (upload.status === 'COMPLETED' && video.status === 'READY') {
      const owner = (await db.select().from(users).where(eq(users.id, video.ownerId)))[0];
      return c.json({ video: toVideoInfo(video, owner?.username ?? '?') } satisfies CompleteUploadResponse);
    }
    if (upload.status === 'ABORTED') return c.json({ error: 'Upload was aborted' }, 409);

    // R2's ListParts is the authoritative record of what actually arrived.
    const parts = await logged('r2.list_parts', { uploadId: upload.id, videoId: video.id }, () =>
      r2!.listParts(video.objectKey, upload.r2UploadId),
    );
    const byNumber = new Map(parts.map((p) => [p.partNumber, p]));
    const missing: number[] = [];
    for (let n = 1; n <= upload.totalParts; n++) {
      if (!byNumber.has(n)) missing.push(n);
    }
    if (missing.length > 0) {
      log({
        op: 'upload.complete',
        ok: false,
        errorCategory: 'conflict',
        uploadId: upload.id,
        videoId: video.id,
        detail: `${missing.length} parts missing`,
      });
      return c.json({ error: 'Upload is incomplete', missingParts: missing.slice(0, 100) }, 409);
    }
    const totalSize = parts.reduce((sum, p) => sum + p.size, 0);
    if (totalSize !== video.size) {
      log({
        op: 'upload.complete',
        ok: false,
        errorCategory: 'conflict',
        uploadId: upload.id,
        videoId: video.id,
        detail: `size mismatch: parts total ${totalSize}, declared ${video.size}`,
      });
      return c.json(
        { error: `Uploaded bytes (${totalSize}) do not match the declared file size (${video.size})` },
        409,
      );
    }

    await logged('r2.complete_multipart', { uploadId: upload.id, videoId: video.id }, () =>
      r2!.completeMultipartUpload(video.objectKey, upload.r2UploadId, parts),
    );

    // Verify the final object exists with the exact expected size before
    // declaring the video READY.
    const head = await r2!.headObject(video.objectKey);
    if (!head || head.size !== video.size) {
      await db
        .update(videos)
        .set({ status: 'FAILED', updatedAt: new Date().toISOString() })
        .where(eq(videos.id, video.id));
      log({
        op: 'upload.complete',
        ok: false,
        errorCategory: 'r2',
        uploadId: upload.id,
        videoId: video.id,
        detail: `post-complete verification failed: head=${head?.size ?? 'missing'}`,
      });
      return c.json({ error: 'Object verification failed after completion' }, 500);
    }

    const now = new Date().toISOString();
    await db.update(uploads).set({ status: 'COMPLETED', updatedAt: now }).where(eq(uploads.id, upload.id));
    await db.update(videos).set({ status: 'READY', updatedAt: now }).where(eq(videos.id, video.id));

    const updated = (await db.select().from(videos).where(eq(videos.id, video.id)))[0]!;
    const owner = (await db.select().from(users).where(eq(users.id, video.ownerId)))[0];
    log({ op: 'upload.complete', ok: true, uploadId: upload.id, videoId: video.id, userId: user.id });
    return c.json({ video: toVideoInfo(updated, owner?.username ?? '?') } satisfies CompleteUploadResponse);
  });

  app.post('/:id/abort', async (c) => {
    const found = await loadOwned(c, c.req.param('id'));
    if (found.error === 'not_found') return c.json({ error: 'Upload not found' }, 404);
    if (found.error === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
    const { upload, video } = found.row;
    if (upload.status === 'COMPLETED') return c.json({ error: 'Upload already completed' }, 409);

    if (upload.status === 'IN_PROGRESS') {
      await logged('r2.abort_multipart', { uploadId: upload.id, videoId: video.id }, () =>
        r2!.abortMultipartUpload(video.objectKey, upload.r2UploadId),
      ).catch(() => {
        // Abort is best-effort; the stale-upload sweep retries later.
      });
    }
    const now = new Date().toISOString();
    await db.update(uploads).set({ status: 'ABORTED', updatedAt: now }).where(eq(uploads.id, upload.id));
    await db.update(videos).set({ status: 'ABORTED', updatedAt: now }).where(eq(videos.id, video.id));
    log({ op: 'upload.abort', ok: true, uploadId: upload.id, videoId: video.id });
    return c.json({ ok: true });
  });

  return app;
}
