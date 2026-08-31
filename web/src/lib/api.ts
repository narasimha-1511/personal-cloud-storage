import type {
  CompleteUploadResponse,
  CreateFolderRequest,
  CreateUploadBatchRequest,
  CreateUploadBatchResponse,
  UploadStatusBatchResponse,
  CreateProjectRequest,
  CreateUploadRequest,
  CreateUploadResponse,
  CreateUserRequest,
  FolderInfo,
  LoginResponse,
  MoveVideoRequest,
  ProjectInfo,
  RenameRequest,
  SignPartResponse,
  SignedUrlResponse,
  UploadStatusResponse,
  UserInfo,
  VideoInfo,
} from '@videovault/shared';
import { TransferError, classifyHttpStatus } from './network';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      // Mobile networks can black-hole a request without ever failing it; an
      // un-timed-out call here would silently freeze the whole upload queue.
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(20_000) : undefined,
      ...init,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new TransferError('network', 'Request timed out');
    }
    throw new TransferError('network', 'Network error');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (res.status === 401) throw new ApiError(401, body?.error ?? 'Unauthorized', body);
    if (res.status >= 500 || res.status === 429) {
      throw new TransferError(classifyHttpStatus(res.status), body?.error ?? `HTTP ${res.status}`, res.status);
    }
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`, body);
  }
  return (await res.json()) as T;
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

export const api = {
  // auth
  login: (username: string, password: string) =>
    request<LoginResponse>('/api/auth/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/auth/logout', post()),
  me: () => request<{ user: UserInfo }>('/api/auth/me'),

  // users (admin)
  listUsers: () => request<{ users: (UserInfo & { active: boolean })[] }>('/api/users'),
  createUser: (body: CreateUserRequest) => request<{ user: UserInfo }>('/api/users', post(body)),
  resetPassword: (id: string, password: string) =>
    request<{ ok: true }>(`/api/users/${id}/reset-password`, post({ password })),
  setUserActive: (id: string, active: boolean) =>
    request<{ ok: true }>(`/api/users/${id}/set-active`, post({ active })),

  // projects / folders
  listProjects: () => request<{ projects: ProjectInfo[] }>('/api/projects'),
  createProject: (body: CreateProjectRequest) =>
    request<{ project: ProjectInfo }>('/api/projects', post(body)),
  renameProject: (id: string, body: RenameRequest) =>
    request<{ ok: true }>(`/api/projects/${id}/rename`, post(body)),
  deleteProject: (id: string, force = false) =>
    request<{ ok: true }>(`/api/projects/${id}/delete`, post({ force })),
  listFolders: (projectId: string) =>
    request<{ folders: FolderInfo[] }>(`/api/projects/${projectId}/folders`),
  createFolder: (projectId: string, body: CreateFolderRequest) =>
    request<{ folder: FolderInfo }>(`/api/projects/${projectId}/folders`, post(body)),
  renameFolder: (id: string, body: RenameRequest) =>
    request<{ ok: true }>(`/api/folders/${id}/rename`, post(body)),
  deleteFolder: (id: string, force = false) =>
    request<{ ok: true }>(`/api/folders/${id}/delete`, post({ force })),

  // uploads
  createUpload: (body: CreateUploadRequest) =>
    request<CreateUploadResponse>('/api/uploads/create', post(body)),
  createUploadBatch: (body: CreateUploadBatchRequest) =>
    request<CreateUploadBatchResponse>('/api/uploads/create-batch', post(body)),
  uploadStatus: (id: string) => request<UploadStatusResponse>(`/api/uploads/${id}/status`),
  uploadStatusBatch: (uploadIds: string[]) =>
    request<UploadStatusBatchResponse>('/api/uploads/status-batch', post({ uploadIds })),
  signPart: (id: string, partNumber: number) =>
    request<SignPartResponse>(`/api/uploads/${id}/sign-part`, post({ partNumber })),
  partDone: (id: string, partNumber: number, etag: string, size: number) =>
    request<{ ok: true }>(`/api/uploads/${id}/part-done`, post({ partNumber, etag, size })),
  completeUpload: (id: string) =>
    request<CompleteUploadResponse>(`/api/uploads/${id}/complete`, post()),
  abortUpload: (id: string) => request<{ ok: true }>(`/api/uploads/${id}/abort`, post()),

  // videos
  listVideos: (params?: { projectId?: string; folderId?: string | null; status?: string }) => {
    const q = new URLSearchParams();
    if (params?.projectId) q.set('projectId', params.projectId);
    if (params?.folderId) q.set('folderId', params.folderId);
    if (params?.status) q.set('status', params.status);
    const qs = q.toString();
    return request<{ videos: VideoInfo[] }>(`/api/videos${qs ? `?${qs}` : ''}`);
  },
  getVideo: (id: string) => request<{ video: VideoInfo }>(`/api/videos/${id}`),
  viewUrl: (id: string) => request<SignedUrlResponse>(`/api/videos/${id}/view-url`, post()),
  downloadUrl: (id: string) => request<SignedUrlResponse>(`/api/videos/${id}/download-url`, post()),
  renameVideo: (id: string, name: string) =>
    request<{ ok: true }>(`/api/videos/${id}/rename`, post({ name })),
  moveVideo: (id: string, body: MoveVideoRequest) =>
    request<{ ok: true }>(`/api/videos/${id}/move`, post(body)),
  deleteVideo: (id: string) => request<{ ok: true }>(`/api/videos/${id}/delete`, post()),

  health: () => request<{ ok: true }>('/api/health'),
};

export type Api = typeof api;
