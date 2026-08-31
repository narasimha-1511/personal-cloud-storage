import { describe, expect, it } from 'vitest';
import type { CompleteUploadResponse, FolderInfo, ProjectInfo, SignPartResponse, SignedUrlResponse, VideoInfo } from '@videovault/shared';
import { createTestApp, post, type TestApp } from './testApp.js';

const PART = 50 * 1024 * 1024;

/** Runs a full 1-part upload and returns the READY video. */
async function readyVideo(t: TestApp, cookie: string, projectId: string, filename = 'VID_1.MP4'): Promise<VideoInfo> {
  const create = await t.app.request(
    '/api/uploads/create',
    post({ filename, size: PART, mimeType: 'video/mp4', projectId }, cookie),
  );
  expect(create.status).toBe(201);
  const { uploadId } = (await create.json()) as { uploadId: string };
  const sign = await t.app.request(`/api/uploads/${uploadId}/sign-part`, post({ partNumber: 1 }, cookie));
  const { url } = (await sign.json()) as SignPartResponse;
  const r2UploadId = new URL(url).searchParams.get('uploadId')!;
  const etag = t.r2.putPart(r2UploadId, 1, PART);
  await t.app.request(`/api/uploads/${uploadId}/part-done`, post({ partNumber: 1, etag, size: PART }, cookie));
  const complete = await t.app.request(`/api/uploads/${uploadId}/complete`, post(undefined, cookie));
  expect(complete.status).toBe(200);
  return ((await complete.json()) as CompleteUploadResponse).video;
}

describe('projects and folders', () => {
  it('admin creates a project; users cannot', async () => {
    const t = await createTestApp();
    const admin = await t.loginAs('narasimha', 'admin');
    const user = await t.loginAs('editor', 'user');

    const denied = await t.app.request('/api/projects', post({ name: 'Himachal 2026' }, user));
    expect(denied.status).toBe(403);

    const created = await t.app.request('/api/projects', post({ name: 'Himachal 2026' }, admin));
    expect(created.status).toBe(201);
    const { project } = (await created.json()) as { project: ProjectInfo };
    expect(project.slug).toBe('himachal-2026');

    const list = await t.app.request('/api/projects', { headers: { cookie: user } });
    const body = (await list.json()) as { projects: ProjectInfo[] };
    expect(body.projects.map((p) => p.slug)).toContain('himachal-2026');
  });

  it('any user can create folders; duplicate slugs are rejected', async () => {
    const t = await createTestApp();
    const user = await t.loginAs('editor', 'user');
    const projectId = await t.seedProject();

    const created = await t.app.request(`/api/projects/${projectId}/folders`, post({ name: 'Day 1' }, user));
    expect(created.status).toBe(201);
    const { folder } = (await created.json()) as { folder: FolderInfo };
    expect(folder.slug).toBe('day-1');

    const dup = await t.app.request(`/api/projects/${projectId}/folders`, post({ name: 'day 1' }, user));
    expect(dup.status).toBe(409);
  });

  it('project delete refuses when videos exist unless forced, and force removes R2 objects', async () => {
    const t = await createTestApp();
    const admin = await t.loginAs('narasimha', 'admin');
    const projectId = await t.seedProject();
    const video = await readyVideo(t, admin, projectId);
    expect(t.r2.objects.has(video.objectKey)).toBe(true);

    const refused = await t.app.request(`/api/projects/${projectId}/delete`, post({}, admin));
    expect(refused.status).toBe(409);

    const forced = await t.app.request(`/api/projects/${projectId}/delete`, post({ force: true }, admin));
    expect(forced.status).toBe(200);
    expect(t.r2.objects.has(video.objectKey)).toBe(false);
  });
});

describe('videos', () => {
  it('lists and filters videos', async () => {
    const t = await createTestApp();
    const admin = await t.loginAs('narasimha', 'admin');
    const projectId = await t.seedProject();
    await readyVideo(t, admin, projectId, 'A.MP4');
    await readyVideo(t, admin, projectId, 'B.MP4');

    const res = await t.app.request(`/api/videos?projectId=${projectId}&status=READY`, {
      headers: { cookie: admin },
    });
    const { videos } = (await res.json()) as { videos: VideoInfo[] };
    expect(videos).toHaveLength(2);
  });

  it('issues signed view/download urls only for READY videos', async () => {
    const t = await createTestApp();
    const admin = await t.loginAs('narasimha', 'admin');
    const projectId = await t.seedProject();
    const video = await readyVideo(t, admin, projectId);

    const view = await t.app.request(`/api/videos/${video.id}/view-url`, post(undefined, admin));
    expect(view.status).toBe(200);
    const { url } = (await view.json()) as SignedUrlResponse;
    expect(url).toContain('disposition=inline');

    // A video still uploading must not be viewable.
    const create = await t.app.request(
      '/api/uploads/create',
      post({ filename: 'pending.mp4', size: PART, mimeType: 'video/mp4', projectId }, admin),
    );
    const { videoId } = (await create.json()) as { videoId: string };
    const notReady = await t.app.request(`/api/videos/${videoId}/view-url`, post(undefined, admin));
    expect(notReady.status).toBe(409);
  });

  it('users can rename/move/delete their own videos but not others', async () => {
    const t = await createTestApp();
    const admin = await t.loginAs('narasimha', 'admin');
    const user = await t.loginAs('editor', 'user');
    const projectId = await t.seedProject();
    const adminVideo = await readyVideo(t, admin, projectId, 'ADMIN.MP4');
    const userVideo = await readyVideo(t, user, projectId, 'USER.MP4');

    // Own rename works; key stays the same.
    const rename = await t.app.request(`/api/videos/${userVideo.id}/rename`, post({ name: 'sunrise.mp4' }, user));
    expect(rename.status).toBe(200);
    const after = (await (await t.app.request(`/api/videos/${userVideo.id}`, { headers: { cookie: user } })).json()) as {
      video: VideoInfo;
    };
    expect(after.video.displayName).toBe('sunrise.mp4');
    expect(after.video.objectKey).toBe(userVideo.objectKey);

    // Someone else's video: forbidden.
    const forbidden = await t.app.request(`/api/videos/${adminVideo.id}/rename`, post({ name: 'nope' }, user));
    expect(forbidden.status).toBe(403);
    const forbiddenDelete = await t.app.request(`/api/videos/${adminVideo.id}/delete`, post(undefined, user));
    expect(forbiddenDelete.status).toBe(403);

    // Admin can delete anyone's video, and the object leaves R2.
    const adminDelete = await t.app.request(`/api/videos/${userVideo.id}/delete`, post(undefined, admin));
    expect(adminDelete.status).toBe(200);
    expect(t.r2.objects.has(userVideo.objectKey)).toBe(false);
  });

  it('move validates the target folder belongs to the same project', async () => {
    const t = await createTestApp();
    const admin = await t.loginAs('narasimha', 'admin');
    const projectId = await t.seedProject();
    const otherProject = await t.seedProject('other');
    const video = await readyVideo(t, admin, projectId);

    const folderRes = await t.app.request(`/api/projects/${otherProject}/folders`, post({ name: 'Drone' }, admin));
    const { folder } = (await folderRes.json()) as { folder: FolderInfo };

    const cross = await t.app.request(`/api/videos/${video.id}/move`, post({ folderId: folder.id }, admin));
    expect(cross.status).toBe(404);

    const toRoot = await t.app.request(`/api/videos/${video.id}/move`, post({ folderId: null }, admin));
    expect(toRoot.status).toBe(200);
  });

  it('deleting a video mid-upload aborts the multipart upload', async () => {
    const t = await createTestApp();
    const admin = await t.loginAs('narasimha', 'admin');
    const projectId = await t.seedProject();
    const create = await t.app.request(
      '/api/uploads/create',
      post({ filename: 'mid.mp4', size: PART * 3, mimeType: 'video/mp4', projectId }, admin),
    );
    const { videoId } = (await create.json()) as { videoId: string };
    expect(t.r2.multiparts.size).toBe(1);

    const del = await t.app.request(`/api/videos/${videoId}/delete`, post(undefined, admin));
    expect(del.status).toBe(200);
    expect(t.r2.multiparts.size).toBe(0);
  });
});
