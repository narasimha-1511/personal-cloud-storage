import type {
  CreateUploadBatchRequest,
  CreateUploadBatchResponse,
  CreateUploadResponse,
  UploadStatusBatchResponse,
  UploadStatusResponse,
} from '@videovault/shared';
import type { LocalUpload, VaultDb } from './db';
import { TransferError, backoffMs, isRetryable } from './network';
import type { PartTransport } from './transport';
import { ApiError } from './api';

/** The slice of the API the upload engine needs; injectable for tests. */
export interface UploadApi {
  createUpload(body: {
    filename: string;
    size: number;
    mimeType: string;
    projectId: string;
    folderId?: string | null;
  }): Promise<CreateUploadResponse>;
  createUploadBatch(body: CreateUploadBatchRequest): Promise<CreateUploadBatchResponse>;
  uploadStatus(id: string): Promise<UploadStatusResponse>;
  uploadStatusBatch(uploadIds: string[]): Promise<UploadStatusBatchResponse>;
  signPart(id: string, partNumber: number): Promise<{ url: string }>;
  partDone(id: string, partNumber: number, etag: string, size: number): Promise<unknown>;
  completeUpload(id: string): Promise<unknown>;
  abortUpload(id: string): Promise<unknown>;
  health(): Promise<unknown>;
}

export interface UploadManagerConfig {
  /** Max simultaneous part uploads. Kept low: the client is a phone. */
  concurrency: number;
  maxAttempts: number;
  partTimeoutMs: number;
  /** While waiting for the network, probe this often. */
  heartbeatMs: number;
  /** First retry delay; doubles each attempt (1s, 2s, 4s, ...). */
  backoffBaseMs: number;
}

export const DEFAULT_CONFIG: UploadManagerConfig = {
  concurrency: 2,
  maxAttempts: 5,
  partTimeoutMs: 120_000,
  heartbeatMs: 30_000,
  backoffBaseMs: 1000,
};

export interface UploadView {
  localId: string;
  filename: string;
  size: number;
  state: LocalUpload['state'];
  error?: string;
  bytesUploaded: number;
  partsDone: number;
  totalParts: number;
  speedBps: number;
  etaSeconds: number | null;
}

interface ActiveState {
  file: File;
  controller: AbortController;
  inflight: Map<number, number>; // partNumber -> bytes sent so far
  samples: { t: number; bytes: number }[];
}

function sameUploadView(a: UploadView, b: UploadView): boolean {
  return (
    a.state === b.state &&
    a.bytesUploaded === b.bytesUploaded &&
    a.partsDone === b.partsDone &&
    a.speedBps === b.speedBps &&
    a.etaSeconds === b.etaSeconds &&
    a.error === b.error &&
    a.filename === b.filename &&
    a.size === b.size &&
    a.totalParts === b.totalParts
  );
}

/**
 * The upload engine. One file transfers at a time; within it up to
 * `concurrency` parts are in flight. Every completed part is persisted to
 * IndexedDB (and reported to the server) before anything else happens, so a
 * refresh, crash, or dead network never loses progress. On resume, only
 * missing parts are uploaded — never completed ones.
 */
export class UploadManager {
  private files = new Map<string, File>();
  private active: ActiveState | null = null;
  private activeId: string | null = null;
  private listeners = new Set<() => void>();
  private uploadsCache = new Map<string, LocalUpload>();
  private partsDoneCache = new Map<string, Set<number>>();
  private consecutiveNetFailures = 0;
  private consecutiveSuccesses = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduling = false;
  private disposed = false;
  private onlineUnsub: (() => void) | null = null;

  constructor(
    private readonly db: VaultDb,
    private readonly api: UploadApi,
    private readonly transport: PartTransport,
    private readonly config: UploadManagerConfig = DEFAULT_CONFIG,
  ) {}

  // ---- lifecycle ----

  /**
   * Loads pending uploads from IndexedDB and reconciles them with the
   * server. R2 (via the server) is the authoritative source for which parts
   * exist; local state is merged up to it.
   */
  async init(): Promise<void> {
    const all = await this.db.uploads.toArray();
    for (const u of all) {
      this.uploadsCache.set(u.localId, u);
      const done = new Set<number>();
      for (const p of await this.db.parts.where('localId').equals(u.localId).toArray()) {
        done.add(p.partNumber);
      }
      this.partsDoneCache.set(u.localId, done);
    }

    // Reconcile all pending uploads with the server in batched calls — with
    // hundreds of queued files this must not be one request per upload.
    const pending = all.filter((u) => u.state !== 'done' && u.state !== 'aborted' && u.state !== 'error');
    const byServerId = new Map(pending.map((u) => [u.serverUploadId, u]));
    const CHUNK = 200;
    for (let i = 0; i < pending.length; i += CHUNK) {
      const chunk = pending.slice(i, i + CHUNK);
      try {
        const { statuses } = await this.api.uploadStatusBatch(chunk.map((u) => u.serverUploadId));
        for (const status of statuses) {
          const u = byServerId.get(status.uploadId);
          if (!u) continue;
          if ('error' in status) {
            await this.setUpload(u.localId, { state: 'error', error: 'Upload no longer exists on the server' });
            continue;
          }
          if (status.status === 'COMPLETED') {
            await this.setUpload(u.localId, { state: 'done' });
            continue;
          }
          if (status.status === 'ABORTED') {
            await this.setUpload(u.localId, { state: 'aborted' });
            continue;
          }
          // Merge the authoritative part list into local state.
          for (const p of status.uploadedParts) {
            await this.recordPartDone(u.localId, p.partNumber, p.etag, p.size, false);
          }
          await this.setUpload(u.localId, { state: 'needs_file' });
          await this.tryReattachHandle(u.localId);
        }
      } catch {
        // Offline right now; leave recoverable and retry on connectivity.
        for (const u of chunk) {
          await this.setUpload(u.localId, { state: 'waiting_network' });
        }
        this.armHeartbeat();
      }
    }

    if (typeof window !== 'undefined') {
      const onOnline = () => void this.kick();
      window.addEventListener('online', onOnline);
      this.onlineUnsub = () => window.removeEventListener('online', onOnline);
    }
    this.emit();
    void this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    this.onlineUnsub?.();
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.active?.controller.abort();
  }

  // ---- public API ----

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Structural sharing: a view object is only replaced when its data
  // changes, so memoized rows skip re-rendering the other 599 uploads on
  // every progress tick.
  private viewCache = new Map<string, UploadView>();

  snapshot(): UploadView[] {
    const views: UploadView[] = [];
    const seen = new Set<string>();
    for (const u of this.uploadsCache.values()) {
      seen.add(u.localId);
      const done = this.partsDoneCache.get(u.localId) ?? new Set();
      const doneBytes = this.doneBytes(u, done);
      let inflightBytes = 0;
      let speedBps = 0;
      if (this.activeId === u.localId && this.active) {
        for (const b of this.active.inflight.values()) inflightBytes += b;
        speedBps = this.currentSpeed();
      }
      const bytesUploaded = Math.min(doneBytes + inflightBytes, u.size);
      const next: UploadView = {
        localId: u.localId,
        filename: u.filename,
        size: u.size,
        state: u.state,
        error: u.error,
        bytesUploaded,
        partsDone: done.size,
        totalParts: u.totalParts,
        speedBps,
        etaSeconds: speedBps > 0 ? Math.round((u.size - bytesUploaded) / speedBps) : null,
      };
      const prev = this.viewCache.get(u.localId);
      if (prev && sameUploadView(prev, next)) {
        views.push(prev);
      } else {
        this.viewCache.set(u.localId, next);
        views.push(next);
      }
    }
    for (const key of this.viewCache.keys()) {
      if (!seen.has(key)) this.viewCache.delete(key);
    }
    return views.sort((a, b) => a.localId.localeCompare(b.localId));
  }

  async addFile(file: File, target: { projectId: string; folderId?: string | null }, handle?: FileSystemFileHandle): Promise<string> {
    const [localId] = await this.addFiles([{ file, handle }], target);
    return localId!;
  }

  /**
   * Registers any number of files in one server round-trip (chunked at 500)
   * — a 600-video picker selection appears in the queue immediately instead
   * of issuing 600 sequential requests. The R2 multipart upload for each
   * file is created server-side only when it starts transferring.
   */
  async addFiles(
    entries: { file: File; handle?: FileSystemFileHandle }[],
    target: { projectId: string; folderId?: string | null },
  ): Promise<string[]> {
    const localIds: string[] = [];
    const CHUNK = 500;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      const { uploads: created } = await this.api.createUploadBatch({
        projectId: target.projectId,
        folderId: target.folderId ?? null,
        files: chunk.map(({ file }) => ({
          filename: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
        })),
      });
      const now = Date.now();
      const rows: LocalUpload[] = chunk.map(({ file, handle }, idx) => ({
        localId: `${now.toString(36)}-${(i + idx).toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        serverUploadId: created[idx]!.uploadId,
        videoId: created[idx]!.videoId,
        projectId: target.projectId,
        folderId: target.folderId ?? null,
        filename: file.name,
        size: file.size,
        lastModified: file.lastModified,
        mimeType: file.type || 'application/octet-stream',
        partSize: created[idx]!.partSize,
        totalParts: created[idx]!.totalParts,
        state: 'queued',
        fileHandle: handle,
        // preserve pick order across chunks
        createdAt: now + i + idx,
        updatedAt: now,
      }));
      await this.db.uploads.bulkPut(rows);
      for (let idx = 0; idx < rows.length; idx++) {
        const row = rows[idx]!;
        this.uploadsCache.set(row.localId, row);
        this.partsDoneCache.set(row.localId, new Set());
        this.files.set(row.localId, chunk[idx]!.file);
        localIds.push(row.localId);
      }
      this.emit();
    }
    void this.schedule();
    return localIds;
  }

  /** Re-attach the file after a reload. Identity must match exactly. */
  async provideFile(localId: string, file: File): Promise<void> {
    const u = this.uploadsCache.get(localId);
    if (!u) throw new Error('Unknown upload');
    if (file.name !== u.filename || file.size !== u.size || file.lastModified !== u.lastModified) {
      throw new Error(
        `This is not the same file. Expected "${u.filename}" (${u.size} bytes). Pick the exact original file so already-uploaded parts stay valid.`,
      );
    }
    this.files.set(localId, file);
    await this.setUpload(localId, { state: 'queued', error: undefined });
    void this.schedule();
  }

  async pause(localId: string): Promise<void> {
    const u = this.uploadsCache.get(localId);
    if (!u) return;
    if (this.activeId === localId) {
      this.active?.controller.abort();
    }
    if (u.state === 'queued' || u.state === 'uploading' || u.state === 'waiting_network') {
      await this.setUpload(localId, { state: 'paused' });
    }
  }

  async resume(localId: string): Promise<void> {
    const u = this.uploadsCache.get(localId);
    if (!u) return;
    if (!this.files.has(localId)) {
      const ok = await this.tryReattachHandle(localId);
      if (!ok) {
        await this.setUpload(localId, { state: 'needs_file' });
        return;
      }
    }
    await this.setUpload(localId, { state: 'queued', error: undefined });
    void this.schedule();
  }

  async abort(localId: string): Promise<void> {
    const u = this.uploadsCache.get(localId);
    if (!u) return;
    if (this.activeId === localId) this.active?.controller.abort();
    try {
      await this.api.abortUpload(u.serverUploadId);
    } catch {
      // Best-effort: the server sweep cleans up stale multiparts.
    }
    await this.db.parts.where('localId').equals(localId).delete();
    this.partsDoneCache.set(localId, new Set());
    await this.setUpload(localId, { state: 'aborted' });
  }

  async remove(localId: string): Promise<void> {
    await this.db.parts.where('localId').equals(localId).delete();
    await this.db.uploads.delete(localId);
    this.uploadsCache.delete(localId);
    this.partsDoneCache.delete(localId);
    this.files.delete(localId);
    this.emit();
  }

  /** Called when connectivity may be back (online event / heartbeat). */
  async kick(): Promise<void> {
    for (const u of this.uploadsCache.values()) {
      if (u.state === 'waiting_network') {
        if (this.files.has(u.localId)) {
          await this.setUpload(u.localId, { state: 'queued' });
        } else {
          const ok = await this.tryReattachHandle(u.localId);
          if (!ok) await this.setUpload(u.localId, { state: 'needs_file' });
        }
      }
    }
    void this.schedule();
  }

  // ---- internals ----

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private async setUpload(localId: string, patch: Partial<LocalUpload>): Promise<void> {
    const u = this.uploadsCache.get(localId);
    if (!u) return;
    const next = { ...u, ...patch, updatedAt: Date.now() };
    this.uploadsCache.set(localId, next);
    await this.db.uploads.put(next);
    this.emit();
  }

  private doneBytes(u: LocalUpload, done: Set<number>): number {
    let bytes = 0;
    for (const n of done) {
      bytes += n === u.totalParts ? u.size - (u.totalParts - 1) * u.partSize : u.partSize;
    }
    return bytes;
  }

  private async recordPartDone(
    localId: string,
    partNumber: number,
    etag: string,
    size: number,
    emit = true,
  ): Promise<void> {
    await this.db.parts.put({ localId, partNumber, etag, size, uploadedAt: Date.now() });
    let set = this.partsDoneCache.get(localId);
    if (!set) {
      set = new Set();
      this.partsDoneCache.set(localId, set);
    }
    set.add(partNumber);
    if (emit) this.emit();
  }

  private async tryReattachHandle(localId: string): Promise<boolean> {
    const u = this.uploadsCache.get(localId);
    if (!u?.fileHandle) return false;
    try {
      const perm = await u.fileHandle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') return false;
      const file = await u.fileHandle.getFile();
      if (file.name !== u.filename || file.size !== u.size) return false;
      this.files.set(localId, file);
      return true;
    } catch {
      return false;
    }
  }

  private armHeartbeat(): void {
    if (this.heartbeatTimer || this.disposed) return;
    this.heartbeatTimer = setTimeout(async () => {
      this.heartbeatTimer = null;
      const anyWaiting = [...this.uploadsCache.values()].some((u) => u.state === 'waiting_network');
      if (!anyWaiting) return;
      try {
        await this.api.health();
        await this.kick();
      } catch {
        this.armHeartbeat();
      }
    }, this.config.heartbeatMs);
  }

  private nextRunnable(): LocalUpload | null {
    const candidates = [...this.uploadsCache.values()]
      .filter((u) => (u.state === 'queued' || u.state === 'uploading') && this.files.has(u.localId))
      .sort((a, b) => a.createdAt - b.createdAt);
    return candidates[0] ?? null;
  }

  private async schedule(): Promise<void> {
    if (this.scheduling || this.disposed) return;
    this.scheduling = true;
    try {
      // One file at a time; loop until nothing is runnable.
      for (;;) {
        const u = this.nextRunnable();
        if (!u) break;
        await this.runUpload(u.localId);
      }
    } finally {
      this.scheduling = false;
    }
  }

  private effectiveConcurrency(): number {
    return this.consecutiveNetFailures >= 3 ? 1 : this.config.concurrency;
  }

  private currentSpeed(): number {
    const a = this.active;
    if (!a || a.samples.length < 2) return 0;
    const cutoff = Date.now() - 10_000;
    const window = a.samples.filter((s) => s.t >= cutoff);
    const first = window[0];
    const last = window[window.length - 1];
    if (!first || !last || last.t === first.t) return 0;
    return Math.max(0, ((last.bytes - first.bytes) / (last.t - first.t)) * 1000);
  }

  private noteProgress(): void {
    const a = this.active;
    if (!a) return;
    const u = this.activeId ? this.uploadsCache.get(this.activeId) : null;
    if (!u) return;
    const done = this.partsDoneCache.get(u.localId) ?? new Set();
    let bytes = this.doneBytes(u, done);
    for (const b of a.inflight.values()) bytes += b;
    a.samples.push({ t: Date.now(), bytes });
    if (a.samples.length > 60) a.samples.splice(0, a.samples.length - 60);
    this.emit();
  }

  private async runUpload(localId: string): Promise<void> {
    const file = this.files.get(localId);
    const u = this.uploadsCache.get(localId);
    if (!file || !u) return;

    const controller = new AbortController();
    this.active = { file, controller, inflight: new Map(), samples: [] };
    this.activeId = localId;
    await this.setUpload(localId, { state: 'uploading', error: undefined });

    const done = this.partsDoneCache.get(localId) ?? new Set<number>();
    const queue: number[] = [];
    for (let n = 1; n <= u.totalParts; n++) {
      if (!done.has(n)) queue.push(n);
    }

    let failure: { kind: 'network' | 'fatal'; message: string } | null = null;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (failure || controller.signal.aborted) return;
        const partNumber = queue.shift();
        if (partNumber === undefined) return;
        const ok = await this.uploadOnePart(u, file, partNumber, controller.signal);
        if (!ok.ok) {
          failure = ok.failure;
          // Put the part back so the resume picks it up.
          queue.unshift(partNumber);
          return;
        }
      }
    };

    // Start workers respecting (possibly degraded) concurrency. Workers exit
    // when the queue drains, so extra workers beyond the queue length no-op.
    const workers = Array.from({ length: Math.min(this.effectiveConcurrency(), Math.max(queue.length, 1)) }, worker);
    await Promise.all(workers);

    this.active = null;
    this.activeId = null;

    if (controller.signal.aborted) {
      // pause() or abort() already set the target state.
      this.emit();
      return;
    }
    if (failure !== null) {
      const f = failure as { kind: 'network' | 'fatal'; message: string };
      if (f.kind === 'network') {
        await this.setUpload(localId, { state: 'waiting_network', error: f.message });
        this.armHeartbeat();
      } else {
        await this.setUpload(localId, { state: 'error', error: f.message });
      }
      return;
    }

    // All parts are uploaded; ask the server to finish. The server verifies
    // against R2's ListParts, so an incomplete upload can never become READY.
    await this.setUpload(localId, { state: 'completing' });
    try {
      await this.api.completeUpload(u.serverUploadId);
      await this.setUpload(localId, { state: 'done' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const missing = (err.body as { missingParts?: number[] } | null)?.missingParts;
        if (missing && missing.length > 0) {
          // Server says some parts never arrived: drop them locally and retry.
          for (const n of missing) {
            await this.db.parts.delete([localId, n]);
            this.partsDoneCache.get(localId)?.delete(n);
          }
          await this.setUpload(localId, { state: 'queued' });
          return;
        }
        await this.setUpload(localId, { state: 'error', error: err.message });
      } else if (err instanceof TransferError && isRetryable(err.kind)) {
        await this.setUpload(localId, { state: 'waiting_network', error: err.message });
        this.armHeartbeat();
      } else {
        await this.setUpload(localId, { state: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private async uploadOnePart(
    u: LocalUpload,
    file: File,
    partNumber: number,
    signal: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; failure: { kind: 'network' | 'fatal'; message: string } }> {
    const start = (partNumber - 1) * u.partSize;
    const blob = file.slice(start, Math.min(start + u.partSize, u.size));

    for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
      if (signal.aborted) return { ok: false, failure: { kind: 'network', message: 'aborted' } };
      try {
        // A fresh presigned URL every attempt also transparently handles
        // expired URLs after long offline gaps.
        const { url } = await this.api.signPart(u.serverUploadId, partNumber);
        const { etag } = await this.transport.putPart(url, blob, {
          timeoutMs: this.config.partTimeoutMs,
          signal,
          onProgress: (loaded) => {
            this.active?.inflight.set(partNumber, loaded);
            this.noteProgress();
          },
        });

        // Persist locally FIRST: even if everything after this dies, the
        // part is never uploaded again.
        this.active?.inflight.delete(partNumber);
        await this.recordPartDone(u.localId, partNumber, etag, blob.size);
        this.consecutiveNetFailures = 0;
        this.consecutiveSuccesses++;
        // Server-side record is best-effort; R2 ListParts is authoritative.
        await this.api.partDone(u.serverUploadId, partNumber, etag, blob.size).catch(() => {});
        this.noteProgress();
        return { ok: true };
      } catch (err) {
        this.active?.inflight.delete(partNumber);
        if (err instanceof DOMException && err.name === 'AbortError') {
          return { ok: false, failure: { kind: 'network', message: 'aborted' } };
        }
        const kind = err instanceof TransferError ? err.kind : 'fatal';
        const message = err instanceof Error ? err.message : String(err);
        if (!isRetryable(kind)) {
          return { ok: false, failure: { kind: 'fatal', message } };
        }
        this.consecutiveSuccesses = 0;
        if (kind === 'network') this.consecutiveNetFailures++;
        if (attempt < this.config.maxAttempts - 1) {
          await this.sleep(backoffMs(attempt, this.config.backoffBaseMs), signal);
        } else {
          return { ok: false, failure: { kind: 'network', message } };
        }
      }
    }
    return { ok: false, failure: { kind: 'network', message: 'retries exhausted' } };
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
