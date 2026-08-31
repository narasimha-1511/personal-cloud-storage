import type { UploadStatusResponse } from '@videovault/shared';
import { ApiError } from '../src/lib/api';
import { TransferError } from '../src/lib/network';
import type { PartTransport, PutPartOptions } from '../src/lib/transport';
import type { UploadApi } from '../src/lib/uploadManager';

interface MockUpload {
  key: string;
  size: number;
  partSize: number;
  totalParts: number;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'ABORTED';
  parts: Map<number, { etag: string; size: number }>;
}

export interface PutRecord {
  uploadId: string;
  partNumber: number;
  size: number;
}

/**
 * In-memory backend that mimics the server + R2 semantics the engine relies
 * on: parts stored by number, ListParts authoritative, complete verifies all
 * parts and the total size.
 */
export class MockBackend {
  uploads = new Map<string, MockUpload>();
  putsReceived: PutRecord[] = [];
  /** When true, every network operation fails like a dead connection. */
  networkDown = false;
  /** If >= 0, the transport starts failing after this many successful PUTs. */
  failPutsAfter = -1;
  partSize = 1024;
  private counter = 0;
  private inflightPuts = 0;
  maxConcurrentPuts = 0;

  private checkNetwork(): void {
    if (this.networkDown) throw new TransferError('network', 'Network error');
  }

  api: UploadApi = {
    createUpload: async (body) => {
      this.checkNetwork();
      const uploadId = `srv-${++this.counter}`;
      const totalParts = Math.max(1, Math.ceil(body.size / this.partSize));
      this.uploads.set(uploadId, {
        key: `projects/test/raw/2026-08-31/${uploadId}-${body.filename}`,
        size: body.size,
        partSize: this.partSize,
        totalParts,
        status: 'IN_PROGRESS',
        parts: new Map(),
      });
      return { uploadId, videoId: `vid-${uploadId}`, partSize: this.partSize, totalParts };
    },

    uploadStatus: async (id) => {
      this.checkNetwork();
      const u = this.get(id);
      return {
        uploadId: id,
        videoId: `vid-${id}`,
        status: u.status,
        videoStatus: u.status === 'COMPLETED' ? 'READY' : 'UPLOADING',
        partSize: u.partSize,
        totalParts: u.totalParts,
        uploadedParts: [...u.parts.entries()].map(([partNumber, p]) => ({
          partNumber,
          etag: p.etag,
          size: p.size,
        })),
      } satisfies UploadStatusResponse;
    },

    signPart: async (id, partNumber) => {
      this.checkNetwork();
      this.get(id);
      return { url: `mock://r2/${id}/${partNumber}` };
    },

    partDone: async (id, partNumber, etag, size) => {
      this.checkNetwork();
      void partNumber;
      void etag;
      void size;
      this.get(id);
      return { ok: true };
    },

    completeUpload: async (id) => {
      this.checkNetwork();
      const u = this.get(id);
      const missing: number[] = [];
      for (let n = 1; n <= u.totalParts; n++) {
        if (!u.parts.has(n)) missing.push(n);
      }
      if (missing.length > 0) {
        throw new ApiError(409, 'Upload is incomplete', { missingParts: missing });
      }
      const total = [...u.parts.values()].reduce((s, p) => s + p.size, 0);
      if (total !== u.size) {
        throw new ApiError(409, 'Size mismatch', {});
      }
      u.status = 'COMPLETED';
      return { video: { id: `vid-${id}`, status: 'READY' } };
    },

    abortUpload: async (id) => {
      this.checkNetwork();
      const u = this.get(id);
      u.status = 'ABORTED';
      u.parts.clear();
      return { ok: true };
    },

    health: async () => {
      this.checkNetwork();
      return { ok: true };
    },
  };

  transport: PartTransport = {
    putPart: async (url: string, body: Blob, opts: PutPartOptions) => {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      this.inflightPuts++;
      this.maxConcurrentPuts = Math.max(this.maxConcurrentPuts, this.inflightPuts);
      try {
        // tiny async hop so concurrent puts overlap
        await new Promise((r) => setTimeout(r, 1));
        if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (this.networkDown) throw new TransferError('network', 'Network error');
        if (this.failPutsAfter >= 0 && this.putsReceived.length >= this.failPutsAfter) {
          throw new TransferError('network', 'Network error (simulated cut)');
        }
        const m = /^mock:\/\/r2\/([^/]+)\/(\d+)$/.exec(url);
        if (!m) throw new TransferError('fatal', `Bad mock URL: ${url}`);
        const uploadId = m[1]!;
        const partNumber = Number(m[2]!);
        const u = this.get(uploadId);
        if (u.status !== 'IN_PROGRESS') throw new TransferError('fatal', 'NoSuchUpload');
        const etag = `"etag-${uploadId}-${partNumber}"`;
        u.parts.set(partNumber, { etag, size: body.size });
        this.putsReceived.push({ uploadId, partNumber, size: body.size });
        opts.onProgress?.(body.size);
        return { etag };
      } finally {
        this.inflightPuts--;
      }
    },
  };

  private get(id: string): MockUpload {
    const u = this.uploads.get(id);
    if (!u) throw new ApiError(404, 'Upload not found');
    return u;
  }
}

export function makeFile(size: number, name = 'VID_2038.MP4', lastModified = 1_725_000_000_000): File {
  return new File([new Uint8Array(size)], name, { type: 'video/mp4', lastModified });
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
