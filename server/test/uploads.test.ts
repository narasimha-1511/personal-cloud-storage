import { describe, expect, it } from 'vitest';
import type {
  CompleteUploadResponse,
  CreateUploadResponse,
  SignPartResponse,
  UploadStatusResponse,
} from '@videovault/shared';
import { createTestApp, post, type TestApp } from './testApp.js';

const PART = 50 * 1024 * 1024;

async function createUpload(
  t: TestApp,
  cookie: string,
  opts: { size?: number; filename?: string; projectId?: string } = {},
) {
  const projectId = opts.projectId ?? (await t.seedProject());
  const res = await t.app.request(
    '/api/uploads/create',
    post(
      {
        filename: opts.filename ?? 'VID_2038.MP4',
        size: opts.size ?? PART * 2 + 1000, // 3 parts by default
        mimeType: 'video/mp4',
        projectId,
      },
      cookie,
    ),
  );
  expect(res.status).toBe(201);
  return { ...((await res.json()) as CreateUploadResponse), projectId };
}

/** Simulates the browser: sign the part, then PUT it straight to (fake) R2. */
async function uploadPart(t: TestApp, cookie: string, uploadId: string, partNumber: number, size: number) {
  const sign = await t.app.request(`/api/uploads/${uploadId}/sign-part`, post({ partNumber }, cookie));
  expect(sign.status).toBe(200);
  const { url } = (await sign.json()) as SignPartResponse;
  const r2UploadId = new URL(url).searchParams.get('uploadId')!;
  const etag = t.r2.putPart(r2UploadId, partNumber, size);
  const done = await t.app.request(
    `/api/uploads/${uploadId}/part-done`,
    post({ partNumber, etag, size }, cookie),
  );
  expect(done.status).toBe(200);
  return etag;
}

describe('multipart upload lifecycle', () => {
  it('uploads, completes, and verifies a 3-part file', async () => {
    const t = await createTestApp();
    const cookie = await t.loginAs('narasimha', 'admin');
    const size = PART * 2 + 1000;
    const { uploadId } = await createUpload(t, cookie, { size });

    await uploadPart(t, cookie, uploadId, 1, PART);
    await uploadPart(t, cookie, uploadId, 2, PART);
    await uploadPart(t, cookie, uploadId, 3, 1000);

    const complete = await t.app.request(`/api/uploads/${uploadId}/complete`, post(undefined, cookie));
    expect(complete.status).toBe(200);
    const { video } = (await complete.json()) as CompleteUploadResponse;
    expect(video.status).toBe('READY');
    expect(video.size).toBe(size);
    expect(video.objectKey).toMatch(/^projects\/himachal-2026\/raw\/\d{4}-\d{2}-\d{2}\/[0-9A-Z]{26}-VID_2038\.MP4$/);
    expect(t.r2.objects.get(video.objectKey)?.size).toBe(size);
  });

  it('refuses to complete with missing parts and reports which are missing', async () => {
    const t = await createTestApp();
    const cookie = await t.loginAs('narasimha', 'admin');
    const { uploadId } = await createUpload(t, cookie);

    await uploadPart(t, cookie, uploadId, 1, PART);
    await uploadPart(t, cookie, uploadId, 3, 1000);

    const complete = await t.app.request(`/api/uploads/${uploadId}/complete`, post(undefined, cookie));
    expect(complete.status).toBe(409);
    const body = (await complete.json()) as { missingParts: number[] };
    expect(body.missingParts).toEqual([2]);
  });

  it('refuses to complete when uploaded bytes do not match the declared size', async () => {
    const t = await createTestApp();
    const cookie = await t.loginAs('narasimha', 'admin');
    const { uploadId } = await createUpload(t, cookie);

    await uploadPart(t, cookie, uploadId, 1, PART);
    await uploadPart(t, cookie, uploadId, 2, PART);
    await uploadPart(t, cookie, uploadId, 3, 999); // one byte short

    const complete = await t.app.request(`/api/uploads/${uploadId}/complete`, post(undefined, cookie));
    expect(complete.status).toBe(409);
    const body = (await complete.json()) as { error: string };
    expect(body.error).toMatch(/do not match/);
  });

  it('status reports uploaded parts from R2 (authoritative resume source)', async () => {
    const t = await createTestApp();
    const cookie = await t.loginAs('narasimha', 'admin');
    const { uploadId } = await createUpload(t, cookie);

    await uploadPart(t, cookie, uploadId, 2, PART);

    const res = await t.app.request(`/api/uploads/${uploadId}/status`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const status = (await res.json()) as UploadStatusResponse;
    expect(status.totalParts).toBe(3);
    expect(status.uploadedParts.map((p) => p.partNumber)).toEqual([2]);
  });

  it('complete is idempotent', async () => {
    const t = await createTestApp();
    const cookie = await t.loginAs('narasimha', 'admin');
    const size = PART;
    const { uploadId } = await createUpload(t, cookie, { size });
    await uploadPart(t, cookie, uploadId, 1, size);

    const first = await t.app.request(`/api/uploads/${uploadId}/complete`, post(undefined, cookie));
    expect(first.status).toBe(200);
    const second = await t.app.request(`/api/uploads/${uploadId}/complete`, post(undefined, cookie));
    expect(second.status).toBe(200);
    const { video } = (await second.json()) as CompleteUploadResponse;
    expect(video.status).toBe('READY');
  });

  it('abort cancels the multipart upload and marks the video aborted', async () => {
    const t = await createTestApp();
    const cookie = await t.loginAs('narasimha', 'admin');
    const { uploadId } = await createUpload(t, cookie);
    await uploadPart(t, cookie, uploadId, 1, PART);

    const abort = await t.app.request(`/api/uploads/${uploadId}/abort`, post(undefined, cookie));
    expect(abort.status).toBe(200);
    expect(t.r2.multiparts.size).toBe(0);

    const sign = await t.app.request(`/api/uploads/${uploadId}/sign-part`, post({ partNumber: 2 }, cookie));
    expect(sign.status).toBe(409);
  });

  it('sanitizes hostile filenames out of object keys', async () => {
    const t = await createTestApp();
    const cookie = await t.loginAs('narasimha', 'admin');
    const size = PART;
    const { uploadId } = await createUpload(t, cookie, {
      size,
      filename: '../../etc/passwd my movie?.mp4',
    });
    await uploadPart(t, cookie, uploadId, 1, size);
    const complete = await t.app.request(`/api/uploads/${uploadId}/complete`, post(undefined, cookie));
    const { video } = (await complete.json()) as CompleteUploadResponse;
    expect(video.objectKey).not.toContain('..');
    expect(video.objectKey).toMatch(/passwd_my_movie_\.mp4$/);
    // Original filename is preserved as metadata even though the key is sanitized.
    expect(video.originalFilename).toBe('../../etc/passwd my movie?.mp4');
  });

  it('rejects uploads to nonexistent projects', async () => {
    const t = await createTestApp();
    const cookie = await t.loginAs('narasimha', 'admin');
    const res = await t.app.request(
      '/api/uploads/create',
      post({ filename: 'a.mp4', size: 1000, mimeType: 'video/mp4', projectId: 'nope' }, cookie),
    );
    expect(res.status).toBe(404);
  });

  it("forbids touching another user's upload", async () => {
    const t = await createTestApp();
    const owner = await t.loginAs('narasimha', 'admin');
    const other = await t.loginAs('editor', 'user');
    const { uploadId } = await createUpload(t, owner);

    for (const path of ['status'] as const) {
      const res = await t.app.request(`/api/uploads/${uploadId}/${path}`, { headers: { cookie: other } });
      expect(res.status).toBe(403);
    }
    const sign = await t.app.request(`/api/uploads/${uploadId}/sign-part`, post({ partNumber: 1 }, other));
    expect(sign.status).toBe(403);
    const abort = await t.app.request(`/api/uploads/${uploadId}/abort`, post(undefined, other));
    expect(abort.status).toBe(403);
  });

  it('rejects unauthenticated upload requests', async () => {
    const t = await createTestApp();
    const res = await t.app.request(
      '/api/uploads/create',
      post({ filename: 'a.mp4', size: 1000, mimeType: 'video/mp4', projectId: 'x' }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects out-of-range part numbers', async () => {
    const t = await createTestApp();
    const cookie = await t.loginAs('narasimha', 'admin');
    const { uploadId } = await createUpload(t, cookie);
    const res = await t.app.request(`/api/uploads/${uploadId}/sign-part`, post({ partNumber: 4 }, cookie));
    expect(res.status).toBe(400);
  });
});
