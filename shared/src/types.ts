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
  createdByUsername: string | null;
  videoCount: number;
  /** Restricted folders are visible only to admins and granted users. */
  restricted: boolean;
  /** User ids with access to a restricted folder. Present for admins only. */
  memberIds?: string[];
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
  /** Hidden files are visible only to their owner and admins. */
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SetHiddenRequest {
  hidden: boolean;
}

export interface FolderAccessRequest {
  restricted: boolean;
  /** Users allowed into the folder when restricted. */
  userIds: string[];
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

/** Bulk registration: one request for a whole picker selection. */
export interface CreateUploadBatchRequest {
  projectId: string;
  folderId?: string | null;
  files: { filename: string; size: number; mimeType: string }[];
}

/** One entry per requested file, in request order. */
export type BatchUploadResult =
  | ({ kind: 'created'; filename: string } & CreateUploadResponse)
  | { kind: 'duplicate'; filename: string; videoId: string; status: VideoStatus };

export interface CreateUploadBatchResponse {
  results: BatchUploadResult[];
}

export interface UploadStatusBatchRequest {
  uploadIds: string[];
}

export interface UploadStatusBatchResponse {
  statuses: (UploadStatusResponse | { uploadId: string; error: 'not_found' | 'forbidden' })[];
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
