import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { eq } from 'drizzle-orm';
import type { VideoInfo } from '@videovault/shared';
import { users, videos } from '../src/db/schema.js';
import { createTestApp, post, type TestApp } from './testApp.js';

async function seedReady(t: TestApp, ownerId: string, projectId: string, name = 'DJI_0001.MP4'): Promise<string> {
  const id = ulid();
  const now = new Date().toISOString();
  await t.r2.putObject(`videos/${id}/original`, Buffer.alloc(1024), 'video/mp4');
  await t.db.insert(videos).values({
    id,
    projectId,
    folderId: null,
    ownerId,
    objectKey: `videos/${id}/original`,
    originalFilename: name,
    displayName: name,
    size: 1024,
    mimeType: 'video/mp4',
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

async function listFor(t: TestApp, cookie: string, projectId: string): Promise<VideoInfo[]> {
  const res = await t.app.request(`/api/videos?projectId=${projectId}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { videos: VideoInfo[] }).videos;
}

describe('per-user download tracking', () => {
  it('signing a download URL marks the file for that user only', async () => {
    const t = await createTestApp();
    const shooter = await t.loginAs('shooter');
    const editor = await t.loginAs('editor');
    const projectId = await t.seedProject();
    const vid = await seedReady(t, await ownerIdOf(t, 'shooter'), projectId);

    expect((await listFor(t, editor, projectId))[0]!.downloadedByMe).toBe(false);

    const dl = await t.app.request(`/api/videos/${vid}/download-url`, post(undefined, editor));
    expect(dl.status).toBe(200);

    // Marked for the editor; the shooter's own view is untouched.
    expect((await listFor(t, editor, projectId))[0]!.downloadedByMe).toBe(true);
    expect((await listFor(t, shooter, projectId))[0]!.downloadedByMe).toBe(false);
  });

  it('mark-downloaded sets and clears the flag in bulk', async () => {
    const t = await createTestApp();
    const editor = await t.loginAs('editor');
    const projectId = await t.seedProject();
    const ownerId = await ownerIdOf(t, 'editor');
    const a = await seedReady(t, ownerId, projectId, 'A.MP4');
    const b = await seedReady(t, ownerId, projectId, 'B.MP4');

    let res = await t.app.request('/api/videos/mark-downloaded', post({ ids: [a, b], downloaded: true }, editor));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { updated: number }).updated).toBe(2);
    expect((await listFor(t, editor, projectId)).every((v) => v.downloadedByMe)).toBe(true);

    res = await t.app.request('/api/videos/mark-downloaded', post({ ids: [a], downloaded: false }, editor));
    expect(res.status).toBe(200);
    const after = await listFor(t, editor, projectId);
    expect(after.find((v) => v.id === a)!.downloadedByMe).toBe(false);
    expect(after.find((v) => v.id === b)!.downloadedByMe).toBe(true);
  });

  it('view-only accounts cannot mark files', async () => {
    const t = await createTestApp();
    const viewer = await t.loginAs('viewer');
    await t.db.update(users).set({ readOnly: true }).where(eq(users.username, 'viewer'));
    const res = await t.app.request('/api/videos/mark-downloaded', post({ ids: ['x'], downloaded: true }, viewer));
    expect(res.status).toBe(403);
  });
});
