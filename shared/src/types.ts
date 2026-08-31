// API contracts shared between server and web.

export type Role = 'admin' | 'user';

export type VideoStatus = 'UPLOADING' | 'READY' | 'ABORTED' | 'FAILED';
export type UploadStatus = 'IN_PROGRESS' | 'COMPLETED' | 'ABORTED';
export type PartStatus = 'PENDING' | 'UPLOADED';

export interface UserInfo {
  id: string;
  username: string;
  role: Role;
  createdAt: string;
}

export interface ProjectInfo {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  videoCount: number;
  folderCount: number;
}

export interface FolderInfo {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  createdAt: string;
  videoCount: number;
}

export interface VideoInfo {
  id: string;
  projectId: string;
  folderId: string | null;
  ownerId: string;
  ownerUsername: string;
  objectKey: string;
  originalFilename: string;
  displayName: string;
  size: number;
  mimeType: string;
  status: VideoStatus;
  createdAt: string;
  updatedAt: string;
}

// ---- Auth ----

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  user: UserInfo;
}

// ---- Admin: users ----

export interface CreateUserRequest {
  username: string;
  password: string;
  role: Role;
}

export interface ResetPasswordRequest {
  password: string;
}

// ---- Projects / folders ----

export interface CreateProjectRequest {
  name: string;
}

export interface RenameRequest {
  name: string;
}

export interface CreateFolderRequest {
  name: string;
}

// ---- Uploads ----

export interface CreateUploadRequest {
  filename: string;
  size: number;
  mimeType: string;
  projectId: string;
  folderId?: string | null;
}

export interface CreateUploadResponse {
  uploadId: string;
  videoId: string;
  partSize: number;
  totalParts: number;
}

export interface UploadStatusResponse {
  uploadId: string;
  videoId: string;
  status: UploadStatus;
  videoStatus: VideoStatus;
  partSize: number;
  totalParts: number;
  /** Part numbers R2 confirms as uploaded (authoritative, from ListParts). */
  uploadedParts: { partNumber: number; etag: string; size: number }[];
}

export interface SignPartRequest {
  partNumber: number;
}

export interface SignPartResponse {
  partNumber: number;
  url: string;
  expiresAt: string;
}

export interface PartDoneRequest {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompleteUploadResponse {
  video: VideoInfo;
}

export interface CompleteUploadConflict {
  error: string;
  missingParts: number[];
}

// ---- Videos ----

export interface VideoListResponse {
  videos: VideoInfo[];
}

export interface SignedUrlResponse {
  url: string;
  expiresAt: string;
}

export interface MoveVideoRequest {
  folderId: string | null;
}

export interface ApiError {
  error: string;
}
