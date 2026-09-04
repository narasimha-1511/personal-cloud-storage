import { describe, expect, it } from 'vitest';
import type { FolderInfo, VideoInfo } from '@videovault/shared';
import { createTestApp, post, type TestApp } from './testApp.js';

const PART = 50 * 1024 * 1024;

async function readyVideo(t: TestApp, cookie: string, projectId: string, filename: string, folderId?: string) {
  const create = await t.app.request(
    '/api/uploads/create',
    post({ filename, size: PART, mimeType: 'video/mp4', projectId, folderId }, cookie),
  );
  expect(create.status).toBe(201);
  const { uploadId, videoId } = (await create.json()) as { uploadId: string; videoId: string };
  const sign = await t.app.request(`/api/uploads/${uploadId}/sign-part`, post({ partNumber: 1 }, cookie));
  const { url } = (await sign.json()) as { url: string };
  const r2UploadId = new URL(url).searchParams.get('uploadId')!;
  const etag = t.r2.putPart(r2UploadId, 1, PART);
  await t.app.request(`/api/uploads/${uploadId}/part-done`, post({ partNumber: 1, etag, size: PART }, cookie));
  await t.app.request(`/api/uploads/${uploadId}/complete`, post(undefined, cookie));
  return videoId;
}

async function listVisible(t: TestApp, cookie: string, projectId: string, folderId?: string) {
  const res = await t.app.request(
    `/api/videos?projectId=${projectId}${folderId ? `&folderId=${folderId}` : ''}`,
    { headers: { cookie } },
  );
  return ((await res.json()) as { videos: VideoInfo[] }).videos;
}

describe('hidden videos', () => {
  it('are invisible to members but visible to owner and admins', async () => {
    const t = await createTestApp();
    const admin = await t.loginAs('narasimha', 'admin');
    const member = await t.loginAs('editor', 'user');
    const projectId = await t.seedProject();

    const videoId = await readyVideo(t, admin, projectId, 'secret.mp4');
    const hide = await t.app.request(`/api/videos/${videoId}/set-hidden`, post({ hidden: true }, admin));
    expect(hide.status).toBe(200);

    // Member: gone from the list, 404 on direct access and signed URLs.
    expect((await listVisible(t, member, projectId)).map((v) => v.id)).not.toContain(videoId);
    expect((await t.app.request(`/api/videos/${videoId}`, { headers: { cookie: member } })).status).toBe(404);
    expect((await t.app.request(`/api/videos/${videoId}/view-url`, post(undefined, member))).status).toBe(404);
    expect((await t.app.request(`/api/videos/${videoId}/download-url`, post(undefined, member))).status).toBe(404);

    // Owner/admin still sees it, flagged as hidden.
    const mine = await listVisible(t, admin, projectId);
    expect(mine.find((v) => v.id === videoId)?.hidden).toBe(true);

    // A member cannot hide someone else's video.
    const memberVideo = await readyVideo(t, member, projectId, 'mine.mp4');
    expect((await t.app.request(`/api/videos/${videoId}/set-hidden`, post({ hidden: false }, member))).status).toBe(403);
    // But can hide their own, and still sees it themselves.
    expect((await t.app.request(`/api/videos/${memberVideo}/set-hidden`, post({ hidden: true }, member))).status).toBe(200);
    expect((await listVisible(t, member, projectId)).map((v) => v.id)).toContain(memberVideo);
  });
});

describe('restricted folders', () => {
  it('hide the folder and its videos from non-granted members', async () => {
    const t = await createTestApp();
    const admin = await t.loginAs('narasimha', 'admin');
    const member = await t.loginAs('editor', 'user');
    const outsider = await t.loginAs('outsider', 'user');
    const projectId = await t.seedProject();

    const folderRes = await t.app.request(`/api/projects/${projectId}/folders`, post({ name: 'Private' }, admin));
    const { folder } = (await folderRes.json()) as { folder: FolderInfo };
    const videoId = await readyVideo(t, admin, projectId, 'raw.mp4', folder.id);

    // Restrict to only `editor`.
    const users = (await (await t.app.request('/api/users', { headers: { cookie: admin } })).json()) as {
      users: { id: string; username: string }[];
    };
    const editorId = users.users.find((u) => u.username === 'editor')!.id;
    const access = await t.app.request(`/api/folders/${folder.id}/access`, post({ restricted: true, userIds: [editorId] }, admin));
    expect(access.status).toBe(200);

    // Outsider: folder invisible, video invisible everywhere, upload into it refused.
    const outsiderFolders = (await (await t.app.request(`/api/projects/${projectId}/folders`, { headers: { cookie: outsider } })).json()) as {
      folders: FolderInfo[];
    };
    expect(outsiderFolders.folders.map((f) => f.id)).not.toContain(folder.id);
    expect((await listVisible(t, outsider, projectId, folder.id)).length).toBe(0);
    expect((await t.app.request(`/api/videos/${videoId}/view-url`, post(undefined, outsider))).status).toBe(404);
    const upload = await t.app.request(
      '/api/uploads/create',
      post({ filename: 'x.mp4', size: 1000, mimeType: 'video/mp4', projectId, folderId: folder.id }, outsider),
    );
    expect(upload.status).toBe(404);

    // Granted member: sees folder and video, can upload.
    const memberFolders = (await (await t.app.request(`/api/projects/${projectId}/folders`, { headers: { cookie: member } })).json()) as {
      folders: FolderInfo[];
    };
    expect(memberFolders.folders.map((f) => f.id)).toContain(folder.id);
    // Member response never includes the member list.
    expect(memberFolders.folders.find((f) => f.id === folder.id)!.memberIds).toBeUndefined();
    expect((await listVisible(t, member, projectId, folder.id)).map((v) => v.id)).toContain(videoId);
    expect((await t.app.request(`/api/videos/${videoId}/view-url`, post(undefined, member))).status).toBe(200);

    // Non-admin cannot change access.
    expect((await t.app.request(`/api/folders/${folder.id}/access`, post({ restricted: false, userIds: [] }, member))).status).toBe(403);

    // Un-restricting opens it up again.
    await t.app.request(`/api/folders/${folder.id}/access`, post({ restricted: false, userIds: [] }, admin));
    expect((await listVisible(t, outsider, projectId, folder.id)).map((v) => v.id)).toContain(videoId);
  });

  it('records who created a folder', async () => {
    const t = await createTestApp();
    const member = await t.loginAs('editor', 'user');
    const projectId = await t.seedProject();
    const res = await t.app.request(`/api/projects/${projectId}/folders`, post({ name: 'Mine' }, member));
    const { folder } = (await res.json()) as { folder: FolderInfo };
    expect(folder.createdByUsername).toBe('editor');
    const list = (await (await t.app.request(`/api/projects/${projectId}/folders`, { headers: { cookie: member } })).json()) as {
      folders: FolderInfo[];
    };
    expect(list.folders[0]!.createdByUsername).toBe('editor');
  });
});

describe('batch view urls', () => {
  it('signs urls only for files the requester may see', async () => {
    const t = await createTestApp();
    const admin = await t.loginAs('narasimha', 'admin');
    const member = await t.loginAs('editor', 'user');
    const projectId = await t.seedProject();
    const visible = await readyVideo(t, admin, projectId, 'open.png');
    const secret = await readyVideo(t, admin, projectId, 'secret.png');
    await t.app.request(`/api/videos/${secret}/set-hidden`, post({ hidden: true }, admin));

    const res = await t.app.request('/api/videos/view-urls', post({ ids: [visible, secret, 'nope'] }, member));
    expect(res.status).toBe(200);
    const { urls } = (await res.json()) as { urls: Record<string, string> };
    expect(Object.keys(urls)).toEqual([visible]);

    const adminRes = await t.app.request('/api/videos/view-urls', post({ ids: [visible, secret] }, admin));
    const adminUrls = (await adminRes.json()) as { urls: Record<string, string> };
    expect(Object.keys(adminUrls.urls).sort()).toEqual([visible, secret].sort());
  });
});
