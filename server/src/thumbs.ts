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

export interface Thumbnailer {
  /**
   * Queues thumbnail generation for any of these rows that still needs it.
   * Returns the ids that will not have a thumbnail on this request, so the
   * caller can tell the client to ask again shortly.
   */
  request(rows: VideoRow[]): string[];
  /** Key for a row's thumbnail, or null if there is nothing usable yet. */
  keyFor(row: VideoRow): string | null;
  /**
   * Whether a derivative for this row is coming. False means the caller should
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

export function isThumbnailable(row: Pick<VideoRow, 'status' | 'mimeType'>): boolean {
  return row.status === 'READY' && row.mimeType.startsWith('image/');
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
    if (!row || !r2 || !isThumbnailable(row)) return;
    if (row.thumbState === 'READY' || row.thumbState === 'UNSUPPORTED') return;

    const finish = async (state: 'READY' | 'UNSUPPORTED' | 'FAILED', key: string | null) => {
      await db
        .update(videos)
        .set({ thumbState: state, thumbKey: key, updatedAt: new Date().toISOString() })
        .where(eq(videos.id, id));
    };

    // Guard the box before decoding: a huge source would blow past the memory
    // budget for a tile nobody will look at closely.
    if (row.size > env.THUMB_MAX_SOURCE_BYTES) {
      await finish('UNSUPPORTED', null);
      return;
    }

    try {
      const source = await r2.getObject(row.objectKey);
      const out = await sharp(source, { limitInputPixels: 300_000_000, failOn: 'none' })
        // No-arg rotate applies EXIF orientation, so phone photos are upright.
        .rotate()
        .resize(env.THUMB_MAX_EDGE, env.THUMB_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: env.THUMB_QUALITY, effort: 4 })
        .toBuffer();
      const key = thumbKeyFor(id);
      await r2.putObject(key, out, 'image/webp');
      await finish('READY', key);
      log({ op: 'thumb.generate', ok: true, videoId: id, bytes: out.length, sourceBytes: row.size });
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
      await finish(terminal ? 'UNSUPPORTED' : 'FAILED', null).catch(() => {});
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
    keyFor(row) {
      return row.thumbState === 'READY' && row.thumbKey ? row.thumbKey : null;
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
        if (!isThumbnailable(row)) continue;
        if (row.thumbState === 'READY' && row.thumbKey) continue;
        if (row.thumbState === 'UNSUPPORTED') continue;
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
