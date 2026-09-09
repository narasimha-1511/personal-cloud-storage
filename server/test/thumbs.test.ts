import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ulid } from 'ulid';
import { videos } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { createTestApp, post, type TestApp } from './testApp.js';

/** A real, decodable JPEG so sharp does actual work in these tests. */
async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 12, g: 90, b: 200 } },
  })
    .jpeg()
    .toBuffer();
}

/**
 * Inserts a READY image straight into the DB with real bytes in storage. The
 * multipart upload path only tracks part sizes, so it cannot produce decodable
 * objects.
 */
async function seedImage(
  t: TestApp,
  ownerId: string,
  projectId: string,
  opts: { bytes?: Buffer; mimeType?: string; size?: number; missing?: boolean } = {},
): Promise<string> {
  const id = ulid();
  const objectKey = `videos/${id}/original`;
  const bytes = opts.bytes ?? (await jpeg(1600, 1200));
  if (!opts.missing) await t.r2.putObject(objectKey, bytes, opts.mimeType ?? 'image/jpeg');
  const now = new Date().toISOString();
  await t.db.insert(videos).values({
    id,
    projectId,
    folderId: null,
    ownerId,
    objectKey,
    originalFilename: 'IMG_0001.JPG',
    displayName: 'IMG_0001.JPG',
    size: opts.size ?? bytes.length,
    mimeType: opts.mimeType ?? 'image/jpeg',
    status: 'READY',
    hidden: false,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function ownerIdOf(t: TestApp, username: string): Promise<string> {
  const rows = await t.db.query.users.findMany();
  return rows.find((u) => u.username === username)!.id;
}

describe('grid thumbnails', () => {
  it('generates a small WebP on first view and serves it thereafter', async () => {
    const t = await createTestApp();
    const cookie = await t.loginAs('narasimha', 'admin');
    const projectId = await t.seedProject();
    const id = await seedImage(t, await ownerIdOf(t, 'narasimha'), projectId);

    // First ask: nothing generated yet, so the id comes back pending with NO
    // url at all. Serving the original here would hand the grid a
    // multi-megabyte file for a thumbnail-sized tile.
    const first = await t.app.request('/api/videos/view-urls', post({ ids: [id], variant: 'thumb' }, cookie));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { urls: Record<string, string>; pending: string[] };
    expect(firstBody.pending).toEqual([id]);
    expect(firstBody.urls[id]).toBeUndefined();

    await t.thumbnailer.idle();

    const row = (await t.db.select().from(videos).where(eq(videos.id, id)).limit(1))[0]!;
    expect(row.thumbState).toBe('READY');
    expect(row.thumbKey).toBe(`thumbs/${id}.webp`);

    // The derivative is a fraction of the original and no wider than the cap.
    const thumb = await t.r2.getObject(row.thumbKey!);
    const meta = await sharp(thumb).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(t.env.THUMB_MAX_EDGE);
    expect(thumb.length).toBeLessThan((await t.r2.getObject(row.objectKey)).length / 4);

    // Second ask: the thumb is served and nothing is left pending.
    const second = await t.app.request('/api/videos/view-urls', post({ ids: [id], variant: 'thumb' }, cookie));
    const secondBody = (await second.json()) as { urls: Record<string, string>; pending: string[] };
    expect(secondBody.pending).toEqual([]);
    expect(secondBody.urls[id]).toContain('thumbs');
  });

  it('serves the original untouched when the variant is not requested', async () => {
    const t = await createTestApp();
    const cookie = await t.loginAs('narasimha', 'admin');
    const projectId = await t.seedProject();
    const id = await seedImage(t, await ownerIdOf(t, 'narasimha'), projectId);

    const res = await t.app.request('/api/videos/view-urls', post({ ids: [id] }, cookie));
    const body = (await res.json()) as { urls: Record<string, string>; pending: string[] };
    expect(body.pending).toEqual([]);
    expect(body.urls[id]).toContain('videos');

    await t.thumbnailer.idle();
    const row = (await t.db.select().from(videos).where(eq(videos.id, id)).limit(1))[0]!;
    expect(row.thumbState).toBeNull();
  });

  it('marks undecodable images unsupported and stops retrying them', async () => {
    const t = await createTestApp();
    const cookie = await t.loginAs('narasimha', 'admin');
    const projectId = await t.seedProject();
    const id = await seedImage(t, await ownerIdOf(t, 'narasimha'), projectId, {
      bytes: Buffer.from('not really an image'),
      mimeType: 'image/heic',
    });

    await t.app.request('/api/videos/view-urls', post({ ids: [id], variant: 'thumb' }, cookie));
    await t.thumbnailer.idle();

    const row = (await t.db.select().from(videos).where(eq(videos.id, id)).limit(1))[0]!;
    expect(row.thumbState).toBe('UNSUPPORTED');
    expect(row.thumbKey).toBeNull();

    // Terminal: a later view falls back to the original and queues nothing.
    const again = await t.app.request('/api/videos/view-urls', post({ ids: [id], variant: 'thumb' }, cookie));
    const body = (await again.json()) as { urls: Record<string, string>; pending: string[] };
    expect(body.pending).toEqual([]);
    expect(body.urls[id]).toContain('videos');
  });

  it('refuses to decode sources larger than the memory budget', async () => {
    const t = await createTestApp({ THUMB_MAX_SOURCE_BYTES: 1024 });
    const cookie = await t.loginAs('narasimha', 'admin');
    const projectId = await t.seedProject();
    const id = await seedImage(t, await ownerIdOf(t, 'narasimha'), projectId, { size: 40 * 1024 * 1024 });

    await t.app.request('/api/videos/view-urls', post({ ids: [id], variant: 'thumb' }, cookie));
    await t.thumbnailer.idle();

    const row = (await t.db.select().from(videos).where(eq(videos.id, id)).limit(1))[0]!;
    expect(row.thumbState).toBe('UNSUPPORTED');
  });

  it('never hands a grid the full original while a thumbnail is being generated', async () => {
    const t = await createTestApp();
    const cookie = await t.loginAs('narasimha', 'admin');
    const projectId = await t.seedProject();
    const owner = await ownerIdOf(t, 'narasimha');
    const ids = [
      await seedImage(t, owner, projectId),
      await seedImage(t, owner, projectId),
      await seedImage(t, owner, projectId),
    ];

    const res = await t.app.request('/api/videos/view-urls', post({ ids, variant: 'thumb' }, cookie));
    const body = (await res.json()) as { urls: Record<string, string>; pending: string[] };

    // The whole point: a first visit must not cost one original per tile.
    expect(body.pending.sort()).toEqual([...ids].sort());
    expect(Object.keys(body.urls)).toEqual([]);

    await t.thumbnailer.idle();

    const warm = await t.app.request('/api/videos/view-urls', post({ ids, variant: 'thumb' }, cookie));
    const warmBody = (await warm.json()) as { urls: Record<string, string>; pending: string[] };
    expect(warmBody.pending).toEqual([]);
    // The fake signer percent-encodes the key, so match the prefix only.
    for (const id of ids) expect(warmBody.urls[id]).toContain('thumbs');
    expect((warmBody as unknown as { thumbed: string[] }).thumbed.sort()).toEqual([...ids].sort());
  });

  it('serves the original for files it will never generate a thumbnail for', async () => {
    // Generation switched off entirely: tiles must still show something.
    const t = await createTestApp({ THUMBNAILS_ENABLED: false });
    const cookie = await t.loginAs('narasimha', 'admin');
    const projectId = await t.seedProject();
    const id = await seedImage(t, await ownerIdOf(t, 'narasimha'), projectId);

    const res = await t.app.request('/api/videos/view-urls', post({ ids: [id], variant: 'thumb' }, cookie));
    const body = (await res.json()) as { urls: Record<string, string>; pending: string[]; thumbed: string[] };
    expect(body.pending).toEqual([]);
    expect(body.urls[id]).toContain('videos');
    // Flagged as NOT a real thumbnail, so the viewer will not reuse it as a
    // cheap preview and download the same original a second time.
    expect(body.thumbed).toEqual([]);
  });

  it('generates what the client asked for most recently first', async () => {
    // One worker, so the order jobs come off the queue is observable.
    const t = await createTestApp({ THUMB_CONCURRENCY: 1 });
    const cookie = await t.loginAs('narasimha', 'admin');
    const projectId = await t.seedProject();
    const owner = await ownerIdOf(t, 'narasimha');
    const early = [];
    for (let i = 0; i < 6; i++) early.push(await seedImage(t, owner, projectId));
    const scrolledTo = [];
    for (let i = 0; i < 2; i++) scrolledTo.push(await seedImage(t, owner, projectId));

    // The top of a long folder is requested first...
    await t.app.request('/api/videos/view-urls', post({ ids: early, variant: 'thumb' }, cookie));
    // ...then the user scrolls and the client asks for what is now on screen.
    await t.app.request('/api/videos/view-urls', post({ ids: scrolledTo, variant: 'thumb' }, cookie));

    await t.thumbnailer.idle();

    const rows = await t.db.select().from(videos);
    const readyAt = (id: string) => rows.find((r) => r.id === id)!.updatedAt;
    // Everything completes, but the just-requested pair was not put behind the
    // whole earlier batch.
    for (const id of [...early, ...scrolledTo]) {
      expect(rows.find((r) => r.id === id)!.thumbState).toBe('READY');
    }
    const lastEarly = early.map(readyAt).sort().at(-1)!;
    const firstScrolled = scrolledTo.map(readyAt).sort()[0]!;
    expect(firstScrolled <= lastEarly).toBe(true);
  });

  it('stops retrying a source that keeps failing instead of re-queueing forever', async () => {
    const t = await createTestApp();
    const cookie = await t.loginAs('narasimha', 'admin');
    const projectId = await t.seedProject();
    // A row whose original is gone from storage: getObject throws every time,
    // and the error is not one of the known "this codec is hopeless" messages.
    const id = await seedImage(t, await ownerIdOf(t, 'narasimha'), projectId, { missing: true });

    const state = async () =>
      (await t.db.select().from(videos).where(eq(videos.id, id)).limit(1))[0]!.thumbState;

    // The first two failures stay retriable — a transient storage blip should
    // not permanently give up on a photo.
    for (let i = 0; i < 2; i++) {
      const res = await t.app.request('/api/videos/view-urls', post({ ids: [id], variant: 'thumb' }, cookie));
      expect(((await res.json()) as { pending: string[] }).pending).toEqual([id]);
      await t.thumbnailer.idle();
      expect(await state()).toBe('FAILED');
    }

    // The third gives up for good, so a grid render can no longer trigger an
    // unbounded stream of DB reads and multi-megabyte storage fetches.
    await t.app.request('/api/videos/view-urls', post({ ids: [id], variant: 'thumb' }, cookie));
    await t.thumbnailer.idle();
    expect(await state()).toBe('UNSUPPORTED');

    const settled = await t.app.request('/api/videos/view-urls', post({ ids: [id], variant: 'thumb' }, cookie));
    const body = (await settled.json()) as { urls: Record<string, string>; pending: string[] };
    expect(body.pending).toEqual([]);
    expect(body.urls[id]).toContain('videos');
  });

  it('leaves videos and other non-image files alone', async () => {
    const t = await createTestApp();
    const cookie = await t.loginAs('narasimha', 'admin');
    const projectId = await t.seedProject();
    const id = await seedImage(t, await ownerIdOf(t, 'narasimha'), projectId, {
      bytes: Buffer.from('fake movie bytes'),
      mimeType: 'video/mp4',
    });

    const res = await t.app.request('/api/videos/view-urls', post({ ids: [id], variant: 'thumb' }, cookie));
    const body = (await res.json()) as { urls: Record<string, string>; pending: string[] };
    expect(body.pending).toEqual([]);
    expect(body.urls[id]).toContain('videos');

    await t.thumbnailer.idle();
    const row = (await t.db.select().from(videos).where(eq(videos.id, id)).limit(1))[0]!;
    expect(row.thumbState).toBeNull();
  });

  it('never generates thumbnails for files the viewer cannot see', async () => {
    const t = await createTestApp();
    const admin = await t.loginAs('narasimha', 'admin');
    const outsider = await t.loginAs('mallesh', 'user');
    const projectId = await t.seedProject();
    const id = await seedImage(t, await ownerIdOf(t, 'narasimha'), projectId);

    // Hidden files are visible only to their owner and admins.
    await t.app.request(`/api/videos/${id}/set-hidden`, post({ hidden: true }, admin));

    const res = await t.app.request('/api/videos/view-urls', post({ ids: [id], variant: 'thumb' }, outsider));
    const body = (await res.json()) as { urls: Record<string, string>; pending: string[] };
    expect(body.urls[id]).toBeUndefined();
    expect(body.pending).toEqual([]);

    await t.thumbnailer.idle();
    const row = (await t.db.select().from(videos).where(eq(videos.id, id)).limit(1))[0]!;
    expect(row.thumbState).toBeNull();
  });
});
