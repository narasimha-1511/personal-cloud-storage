import { and, eq, lt } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { uploads, videos } from './db/schema.js';
import type { R2Client } from './r2.js';
import { log } from './log.js';

const STALE_DAYS = 7;

/**
 * Aborts multipart uploads that have seen no activity for a week so R2
 * doesn't accumulate invisible storage cost from abandoned uploads.
 */
export async function sweepStaleUploads(db: Db, r2: R2Client | null, staleDays = STALE_DAYS): Promise<number> {
  if (!r2) return 0;
  const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();
  const stale = await db
    .select({ upload: uploads, video: videos })
    .from(uploads)
    .innerJoin(videos, eq(uploads.videoId, videos.id))
    .where(and(eq(uploads.status, 'IN_PROGRESS'), lt(uploads.updatedAt, cutoff)));

  for (const { upload, video } of stale) {
    if (upload.r2UploadId) {
      await r2.abortMultipartUpload(video.objectKey, upload.r2UploadId).catch(() => {});
    }
    const now = new Date().toISOString();
    await db.update(uploads).set({ status: 'ABORTED', updatedAt: now }).where(eq(uploads.id, upload.id));
    await db.update(videos).set({ status: 'ABORTED', updatedAt: now }).where(eq(videos.id, video.id));
    log({ op: 'sweep.abort_stale', ok: true, uploadId: upload.id, videoId: video.id });
  }
  return stale.length;
}
