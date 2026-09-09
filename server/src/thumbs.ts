import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { videos } from './db/schema.js';
import type { R2Client } from './r2.js';
import type { Env } from './env.js';
import { log } from './log.js';

type VideoRow = typeof videos.$inferSelect;

// libvips defaults to caching decoded images and to one worker thread per core.
// Neither helps here — every photo is processed exactly once — and both make
// peak memory unpredictable on a small VPS shared with the upload path.
// THUMB_CONCURRENCY is then the only knob that governs memory.
sharp.cache(false);
sharp.concurrency(1);

/** Which derivative a caller wants: a grid tile or the viewer's display copy. */
export type Derivative = 'thumb' | 'preview';

export interface Thumbnailer {
  /**
   * Queues generation for any of these rows that still needs it. Returns the
   * ids that will not have their derivatives on this request, so the caller can
   * tell the client to ask again shortly.
   */
  request(rows: VideoRow[]): string[];
  /** Key for one of a row's derivatives, or null if there is nothing usable. */
  keyFor(row: VideoRow, which: Derivative): string | null;
  /**
   * Whether derivatives for this row are coming. False means the caller should
   * serve the original instead — the file is not an image, generation is
   * switched off, or it has been ruled out permanently.
   */
  willGenerate(row: VideoRow): boolean;
  /** Awaits the current queue. Tests only — production never blocks on this. */
  idle(): Promise<void>;
}

export function thumbKeyFor(videoId: string): string {
  return `thumbs/${videoId}.webp`;
}

export function previewKeyFor(videoId: string): string {
  return `previews/${videoId}.webp`;
}

export function isThumbnailable(row: Pick<VideoRow, 'status' | 'mimeType'>): boolean {
  return row.status === 'READY' && row.mimeType.startsWith('image/');
}

/**
 * True when a row still owes us work. Rows generated before display previews
 * existed are READY with a thumbnail but no preview, so they are re-generated
 * the next time they are looked at.
 */
function needsWork(row: VideoRow): boolean {
  if (!isThumbnailable(row)) return false;
  if (row.thumbState === 'UNSUPPORTED') return false;
  return !(row.thumbState === 'READY' && row.thumbKey && row.previewKey);
}

/**
 * Generates small WebP derivatives for image files, lazily and at most once
 * each, so grid tiles fetch ~25 KB instead of a multi-megabyte original.
 *
 * Work is queued rather than done inline: the request that discovers a missing
 * thumbnail returns immediately with the ids still pending, and the client
 * re-asks. Concurrency is deliberately low — decoding a 12 MP JPEG costs real
 * memory, and this shares a small VPS with the upload/download paths.
 */
export function createThumbnailer({
  db,
  r2,
  env,
}: {
  db: Db;
  r2: R2Client | null;
  env: Env;
}): Thumbnailer {
  /** Ids waiting to be generated, most important first. */
  const queue: string[] = [];
  /** Queued but not started — these can still be re-prioritized. */
  const queued = new Set<string>();
  /** Currently generating; re-requesting one of these changes nothing. */
  const active = new Set<string>();
  /**
   * Ceiling on outstanding work. A very large folder would otherwise let one
   * client enqueue tens of thousands of jobs; anything trimmed is simply
   * re-requested the next time it is actually on screen.
   */
  const MAX_QUEUE = 2000;
  /**
   * Failures per id this process has seen. A missing original or a wedged
   * bucket would otherwise be re-queued by every single grid render — each
   * retry costing a DB read and an R2 GET of up to THUMB_MAX_SOURCE_BYTES —
   * and never converge. In memory only: a restart is a fair time to retry.
   */
  const failures = new Map<string, number>();
  const MAX_FAILURES = 3;
  let running = 0;
  let idleWaiters: (() => void)[] = [];

  function settleIfIdle(): void {
    if (running === 0 && queue.length === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters = [];
    }
  }

  function pump(): void {
    while (running < env.THUMB_CONCURRENCY && queue.length > 0) {
      const id = queue.shift()!;
      queued.delete(id);
      active.add(id);
      running++;
      void generate(id)
        .catch(() => {})
        .finally(() => {
          running--;
          active.delete(id);
          pump();
          settleIfIdle();
        });
    }
    settleIfIdle();
  }

  async function generate(id: string): Promise<void> {
    const rows = await db.select().from(videos).where(eq(videos.id, id)).limit(1);
    const row = rows[0];
    if (!row || !r2 || !needsWork(row)) return;

    const finish = async (
      state: 'READY' | 'UNSUPPORTED' | 'FAILED',
      keys: { thumbKey: string | null; previewKey: string | null },
    ) => {
      await db
        .update(videos)
        .set({ thumbState: state, ...keys, updatedAt: new Date().toISOString() })
        .where(eq(videos.id, id));
    };
    const giveUp = (state: 'UNSUPPORTED' | 'FAILED') => finish(state, { thumbKey: null, previewKey: null });

    // Guard the box before decoding: a huge source would blow past the memory
    // budget for a tile nobody will look at closely.
    if (row.size > env.THUMB_MAX_SOURCE_BYTES) {
      await giveUp('UNSUPPORTED');
      return;
    }

    try {
      const source = await r2.getObject(row.objectKey);

      // Decode the source once, for the larger output only, then derive the
      // tile from that result. Decoding a 40 MP JPEG is by far the most
      // expensive step here, and running two pipelines over the same source
      // pays it twice; re-scaling an already-small 2048px image is trivial by
      // comparison and visually indistinguishable at tile size.
      const preview = await sharp(source, { limitInputPixels: 300_000_000, failOn: 'none' })
        // No-arg rotate applies EXIF orientation, so phone photos are upright.
        .rotate()
        .resize(env.PREVIEW_MAX_EDGE, env.PREVIEW_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: env.PREVIEW_QUALITY, effort: 4 })
        .toBuffer();

      const thumb = await sharp(preview)
        .resize(env.THUMB_MAX_EDGE, env.THUMB_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: env.THUMB_QUALITY, effort: 4 })
        .toBuffer();

      const thumbKey = thumbKeyFor(id);
      const previewKey = previewKeyFor(id);
      await r2.putObject(thumbKey, thumb, 'image/webp');
      await r2.putObject(previewKey, preview, 'image/webp');
      await finish('READY', { thumbKey, previewKey });
      log({
        op: 'thumb.generate',
        ok: true,
        videoId: id,
        bytes: thumb.length,
        previewBytes: preview.length,
        sourceBytes: row.size,
      });
    } catch (err) {
      // A codec libvips cannot read (HEIC, some RAW) will never succeed, so it
      // is marked UNSUPPORTED and never retried; anything else may be
      // transient and is left FAILED for a later view to pick up.
      const message = err instanceof Error ? err.message : String(err);
      const unsupported = /unsupported image format|bad extension|magick|heif|unable to open/i.test(message);
      const count = (failures.get(id) ?? 0) + 1;
      failures.set(id, count);
      // Give up permanently once a source has failed repeatedly — whatever is
      // wrong with it is not going to fix itself on the next grid render.
      const terminal = unsupported || count >= MAX_FAILURES;
      await giveUp(terminal ? 'UNSUPPORTED' : 'FAILED').catch(() => {});
      log({
        op: 'thumb.generate',
        ok: false,
        videoId: id,
        errorCategory: unsupported ? 'validation' : 'internal',
        detail: message,
        attempt: count,
      });
    }
  }

  return {
    keyFor(row, which) {
      if (row.thumbState !== 'READY') return null;
      return (which === 'thumb' ? row.thumbKey : row.previewKey) ?? null;
    },

    willGenerate(row) {
      if (!r2 || !env.THUMBNAILS_ENABLED) return false;
      if (!isThumbnailable(row)) return false;
      // Terminal: nothing will ever be produced for this one.
      return row.thumbState !== 'UNSUPPORTED';
    },

    /**
     * Rows arrive in the caller's priority order — the client asks for the
     * files it is currently showing — and that order wins. Work already queued
     * but not started is pushed behind it, so scrolling into a new stretch of a
     * folder generates those photos next instead of putting them behind every
     * photo requested earlier. Jobs already running are left alone.
     */
    request(rows) {
      const pending: string[] = [];
      if (!r2 || !env.THUMBNAILS_ENABLED) return pending;

      const promoted: string[] = [];
      for (const row of rows) {
        if (!needsWork(row)) continue;
        pending.push(row.id);
        if (active.has(row.id)) continue;
        promoted.push(row.id);
      }

      if (promoted.length > 0) {
        const front = new Set(promoted);
        const rest = queue.filter((id) => !front.has(id));
        queue.length = 0;
        for (const id of promoted) queue.push(id);
        for (const id of rest) queue.push(id);
        if (queue.length > MAX_QUEUE) queue.length = MAX_QUEUE;
        queued.clear();
        for (const id of queue) queued.add(id);
      }

      pump();
      return pending;
    },

    idle() {
      if (running === 0 && queue.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}
