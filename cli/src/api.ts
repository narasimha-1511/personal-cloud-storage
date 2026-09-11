import { request } from 'undici';
import type {
  CreateUploadBatchResponse,
  FolderInfo,
  ProjectInfo,
  UploadStatusResponse,
} from '@videovault/shared';

export interface Session {
  url: string;
  cookie: string;
}

async function json<T>(session: Session, path: string, body?: unknown): Promise<T> {
  const res = await request(new URL(path, session.url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: session.cookie,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headersTimeout: 20_000,
  });
  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let message = `HTTP ${res.statusCode}`;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {}
    throw new Error(`${path}: ${message}`);
  }
  return JSON.parse(text) as T;
}

/** The server API surface the uploader needs; injectable for tests. */
export interface CliApi {
  listProjects(): Promise<ProjectInfo[]>;
  listFolders(projectId: string): Promise<FolderInfo[]>;
  createBatch(
    projectId: string,
    folderId: string | null,
    files: { filename: string; size: number; mimeType: string }[],
  ): Promise<CreateUploadBatchResponse>;
  status(uploadId: string): Promise<UploadStatusResponse>;
  signPart(uploadId: string, partNumber: number): Promise<string>;
  partDone(uploadId: string, partNumber: number, etag: string, size: number): Promise<void>;
  complete(uploadId: string): Promise<void>;
}

export function makeApi(session: Session): CliApi {
  return {
    listProjects: async () => (await json<{ projects: ProjectInfo[] }>(session, '/api/projects')).projects,
    listFolders: async (projectId) =>
      (await json<{ folders: FolderInfo[] }>(session, `/api/projects/${projectId}/folders`)).folders,
    createBatch: (projectId, folderId, files) =>
      json(session, '/api/uploads/create-batch', { projectId, folderId, files }),
    status: (uploadId) => json(session, `/api/uploads/${uploadId}/status`),
    signPart: async (uploadId, partNumber) =>
      (await json<{ url: string }>(session, `/api/uploads/${uploadId}/sign-part`, { partNumber })).url,
    partDone: async (uploadId, partNumber, etag, size) => {
      await json(session, `/api/uploads/${uploadId}/part-done`, { partNumber, etag, size });
    },
    complete: async (uploadId) => {
      await json(session, `/api/uploads/${uploadId}/complete`, {});
    },
  };
}

export async function login(url: string, username: string, password: string): Promise<Session> {
  const res = await request(new URL('/api/auth/login', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
    headersTimeout: 20_000,
  });
  const text = await res.body.text();
  if (res.statusCode !== 200) {
    let message = `HTTP ${res.statusCode}`;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {}
    throw new Error(message);
  }
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = raw?.split(';')[0];
  if (!cookie) throw new Error('Server returned no session cookie');
  return { url, cookie };
}
