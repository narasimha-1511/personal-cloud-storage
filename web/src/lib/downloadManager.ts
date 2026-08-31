import type { LocalDownload, VaultDb } from './db';
import { TransferError, backoffMs } from './network';

/**
 * Resumable downloads: fetch with a Range header, stream chunks to disk via
 * the File System Access API, checkpoint progress to IndexedDB. The whole
 * file is never held in memory. If the connection (or the tab) dies at
 * 4.7 GB, the next attempt continues with `Range: bytes=4700000000-`.
 *
 * Durability note: FSA writables commit to the real file only on close(), so
 * we checkpoint (close + reopen) every CHECKPOINT_BYTES. On resume we trust
 * the actual on-disk file size, not just our bookkeeping.
 */

export interface DownloadApi {
  downloadUrl(videoId: string): Promise<{ url: string }>;
}

export interface DownloadView {
  videoId: string;
  filename: string;
  totalSize: number;
  bytesWritten: number;
  state: LocalDownload['state'];
  error?: string;
  speedBps: number;
  etaSeconds: number | null;
}

export interface DownloadManagerConfig {
  /** Commit-to-disk interval. Larger = faster, smaller = less to re-download. */
  checkpointBytes: number;
  maxAttempts: number;
  backoffBaseMs: number;
}

const DEFAULT_CONFIG: DownloadManagerConfig = {
  checkpointBytes: 64 * 1024 * 1024,
  maxAttempts: 5,
  backoffBaseMs: 1000,
};

interface ActiveDownload {
  controller: AbortController;
  samples: { t: number; bytes: number }[];
}

export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

export class DownloadManager {
  private active = new Map<string, ActiveDownload>();
  private listeners = new Set<() => void>();
  private cache = new Map<string, LocalDownload>();

  constructor(
    private readonly db: VaultDb,
    private readonly api: DownloadApi,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
    private readonly config: DownloadManagerConfig = DEFAULT_CONFIG,
  ) {}

  async init(): Promise<void> {
    for (const d of await this.db.downloads.toArray()) {
      this.cache.set(d.videoId, d);
      if (d.state === 'downloading') {
        // We were killed mid-download; it needs a user gesture to reopen the
        // file handle, so surface it as paused.
        await this.patch(d.videoId, { state: 'paused' });
      }
    }
    this.emit();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Structural sharing: unchanged rows keep their identity so memoized
  // components skip re-rendering them (see UploadManager.snapshot).
  private viewCache = new Map<string, DownloadView>();

  snapshot(): DownloadView[] {
    const views = [...this.cache.values()].map((d) => {
      const a = this.active.get(d.videoId);
      const speedBps = a ? this.speed(a) : 0;
      const next: DownloadView = {
        videoId: d.videoId,
        filename: d.filename,
        totalSize: d.totalSize,
        bytesWritten: d.bytesWritten,
        state: d.state,
        error: d.error,
        speedBps,
        etaSeconds: speedBps > 0 ? Math.round((d.totalSize - d.bytesWritten) / speedBps) : null,
      };
      const prev = this.viewCache.get(d.videoId);
      if (
        prev &&
        prev.state === next.state &&
        prev.bytesWritten === next.bytesWritten &&
        prev.speedBps === next.speedBps &&
        prev.etaSeconds === next.etaSeconds &&
        prev.error === next.error
      ) {
        return prev;
      }
      this.viewCache.set(d.videoId, next);
      return next;
    });
    for (const key of this.viewCache.keys()) {
      if (!this.cache.has(key)) this.viewCache.delete(key);
    }
    return views.sort((a, b) => a.filename.localeCompare(b.filename));
  }

  /** Starts (or restarts) a download. `handle` comes from showSaveFilePicker. */
  async start(
    video: { id: string; displayName: string; size: number },
    handle: FileSystemFileHandle,
  ): Promise<void> {
    const existing = this.cache.get(video.id);
    const record: LocalDownload = existing ?? {
      videoId: video.id,
      filename: video.displayName,
      totalSize: video.size,
      bytesWritten: 0,
      state: 'downloading',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    record.fileHandle = handle;
    record.state = 'downloading';
    record.error = undefined;
    this.cache.set(video.id, record);
    await this.db.downloads.put(record);
    this.emit();
    void this.run(video.id);
  }

  /** Resume with the stored handle (permission permitting) — a user gesture. */
  async resume(videoId: string): Promise<'ok' | 'needs_handle'> {
    const d = this.cache.get(videoId);
    if (!d) return 'needs_handle';
    if (!d.fileHandle) return 'needs_handle';
    try {
      let perm = await d.fileHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        perm = await d.fileHandle.requestPermission({ mode: 'readwrite' });
      }
      if (perm !== 'granted') return 'needs_handle';
    } catch {
      return 'needs_handle';
    }
    await this.patch(videoId, { state: 'downloading', error: undefined });
    void this.run(videoId);
    return 'ok';
  }

  pause(videoId: string): void {
    this.active.get(videoId)?.controller.abort();
  }

  async remove(videoId: string): Promise<void> {
    this.pause(videoId);
    await this.db.downloads.delete(videoId);
    this.cache.delete(videoId);
    this.emit();
  }

  // ---- internals ----

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private async patch(videoId: string, p: Partial<LocalDownload>): Promise<void> {
    const d = this.cache.get(videoId);
    if (!d) return;
    const next = { ...d, ...p, updatedAt: Date.now() };
    this.cache.set(videoId, next);
    await this.db.downloads.put(next);
    this.emit();
  }

  private speed(a: ActiveDownload): number {
    if (a.samples.length < 2) return 0;
    const cutoff = Date.now() - 10_000;
    const win = a.samples.filter((s) => s.t >= cutoff);
    const first = win[0];
    const last = win[win.length - 1];
    if (!first || !last || last.t === first.t) return 0;
    return Math.max(0, ((last.bytes - first.bytes) / (last.t - first.t)) * 1000);
  }

  private async run(videoId: string): Promise<void> {
    if (this.active.has(videoId)) return;
    const controller = new AbortController();
    const activeState: ActiveDownload = { controller, samples: [] };
    this.active.set(videoId, activeState);

    try {
      for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
        const d = this.cache.get(videoId);
        if (!d || !d.fileHandle || controller.signal.aborted) return;
        try {
          await this.downloadFrom(videoId, d.fileHandle, controller.signal, activeState);
          return; // finished or cleanly stopped
        } catch (err) {
          if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
            await this.patch(videoId, { state: 'paused' });
            return;
          }
          const retryable = err instanceof TransferError && err.kind !== 'fatal';
          if (!retryable) {
            await this.patch(videoId, {
              state: 'error',
              error: err instanceof Error ? err.message : String(err),
            });
            return;
          }
          if (attempt < this.config.maxAttempts - 1) {
            await this.patch(videoId, { state: 'downloading', error: 'Connection lost — retrying…' });
            await new Promise((r) => setTimeout(r, backoffMs(attempt, this.config.backoffBaseMs)));
          } else {
            await this.patch(videoId, {
              state: 'waiting_network',
              error: 'Connection lost. Progress is saved — resume when you are back online.',
            });
          }
        }
      }
    } finally {
      this.active.delete(videoId);
      this.emit();
    }
  }

  private async downloadFrom(
    videoId: string,
    handle: FileSystemFileHandle,
    signal: AbortSignal,
    activeState: ActiveDownload,
  ): Promise<void> {
    const record = this.cache.get(videoId)!;

    // The on-disk file is the truth about how much we actually have.
    const onDisk = await handle.getFile();
    let offset = Math.min(onDisk.size, record.totalSize);
    await this.patch(videoId, { bytesWritten: offset, state: 'downloading' });

    if (offset >= record.totalSize) {
      await this.finish(videoId, handle);
      return;
    }

    const { url } = await this.api.downloadUrl(videoId);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new TransferError('network', 'Network error while connecting');
    }

    if (offset > 0 && res.status === 200) {
      // Server ignored our Range request — never blindly rewrite the file.
      res.body?.cancel().catch(() => {});
      throw new TransferError('fatal', 'Server does not support resuming (no Range support)');
    }
    if (!(res.status === 206 || (res.status === 200 && offset === 0))) {
      throw new TransferError(res.status === 403 ? 'transient' : 'network', `HTTP ${res.status}`);
    }
    if (!res.body) throw new TransferError('network', 'Empty response body');

    let writable = await handle.createWritable({ keepExistingData: true });
    await writable.seek(offset);
    let sinceCheckpoint = 0;

    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read().catch((err) => {
          if (err instanceof DOMException && err.name === 'AbortError') throw err;
          throw new TransferError('network', 'Connection lost mid-stream');
        });
        if (done) break;
        if (value && value.byteLength > 0) {
          await writable.write(value);
          offset += value.byteLength;
          sinceCheckpoint += value.byteLength;
          activeState.samples.push({ t: Date.now(), bytes: offset });
          if (activeState.samples.length > 100) activeState.samples.splice(0, 50);

          if (sinceCheckpoint >= this.config.checkpointBytes) {
            // close() is what actually commits bytes to the real file.
            await writable.close();
            await this.patch(videoId, { bytesWritten: offset });
            writable = await handle.createWritable({ keepExistingData: true });
            await writable.seek(offset);
            sinceCheckpoint = 0;
          } else {
            await this.patch(videoId, { bytesWritten: offset });
          }
        }
      }
      await writable.close();
      await this.patch(videoId, { bytesWritten: offset });
    } catch (err) {
      // Commit whatever we have before surfacing the failure.
      await writable.close().catch(() => {});
      const committed = (await handle.getFile().catch(() => null))?.size;
      if (committed !== undefined) await this.patch(videoId, { bytesWritten: Math.min(committed, record.totalSize) });
      throw err;
    }

    if (offset < record.totalSize) {
      throw new TransferError('network', 'Stream ended before the file was complete');
    }
    await this.finish(videoId, handle);
  }

  private async finish(videoId: string, handle: FileSystemFileHandle): Promise<void> {
    const record = this.cache.get(videoId)!;
    const final = await handle.getFile();
    if (final.size !== record.totalSize) {
      await this.patch(videoId, {
        state: 'error',
        error: `Size check failed: file is ${final.size} bytes, expected ${record.totalSize}`,
      });
      return;
    }
    await this.patch(videoId, { state: 'done', bytesWritten: record.totalSize, error: undefined });
  }
}
