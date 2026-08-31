import Dexie, { type EntityTable } from 'dexie';

/**
 * Client-side persistent upload/download state. This is what makes "if the
 * internet dies, nothing is lost" true across refreshes and restarts.
 */

export type LocalUploadState =
  | 'queued'
  | 'uploading'
  | 'paused' // user pressed pause
  | 'waiting_network' // retries exhausted; waiting for connectivity
  | 'needs_file' // page reloaded; we need the File again to continue
  | 'completing'
  | 'done'
  | 'error'
  | 'aborted';

export interface LocalUpload {
  localId: string;
  serverUploadId: string;
  videoId: string;
  projectId: string;
  folderId: string | null;
  filename: string;
  size: number;
  lastModified: number;
  mimeType: string;
  partSize: number;
  totalParts: number;
  state: LocalUploadState;
  error?: string;
  /** Present when the browser let us keep a durable handle to the file. */
  fileHandle?: FileSystemFileHandle;
  createdAt: number;
  updatedAt: number;
}

export interface LocalPart {
  localId: string;
  partNumber: number;
  etag: string;
  size: number;
  uploadedAt: number;
}

export type LocalDownloadState = 'queued' | 'downloading' | 'paused' | 'waiting_network' | 'done' | 'error';

export interface LocalDownload {
  videoId: string;
  filename: string;
  totalSize: number;
  bytesWritten: number;
  state: LocalDownloadState;
  error?: string;
  fileHandle?: FileSystemFileHandle;
  createdAt: number;
  updatedAt: number;
}

export interface Setting {
  key: string;
  value: unknown;
}

export class VaultDb extends Dexie {
  uploads!: EntityTable<LocalUpload, 'localId'>;
  parts!: Dexie.Table<LocalPart, [string, number]>;
  downloads!: EntityTable<LocalDownload, 'videoId'>;
  settings!: EntityTable<Setting, 'key'>;

  constructor(name = 'video-vault') {
    super(name);
    this.version(1).stores({
      uploads: 'localId, state, [filename+size+lastModified]',
      parts: '[localId+partNumber], localId',
      downloads: 'videoId, state',
      settings: 'key',
    });
  }
}

export const db = new VaultDb();
