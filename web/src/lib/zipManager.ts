import type { DownloadApi } from './downloadManager';
import { TransferError, backoffMs, classifyHttpStatus } from './network';
import { ZipWriter, uniqueEntryName } from './zip';

/**
 * Packs a set of files into a single ZIP as they are downloaded.
 *
 * This is the "just give me one file" path: the editor picks a save location
 * once and gets one archive, instead of a save prompt (or a folder full of
 * separate transfers) per photo. Bytes go straight from R2 through the ZIP
 * writer to disk, so a 200 GB selection never lands in memory.
 *
 * The one thing it deliberately does not do is survive a reload. A ZIP is a
 * forward-only stream — the archive being written cannot be reopened and
 * continued — so there is nothing to persist, and the UI says so. Within a
 * session it is a lot tougher than that sounds: a dropped connection is
 * retried with `Range` from the exact byte the archive got to, which is why an
 * interrupted file does not restart from zero either. For downloads that must
 * survive a browser restart, the per-file DownloadManager is still the answer.
 */

export interface ZipTarget {
  id: string;
  displayName: string;
  size: number;
  /** Shown as the entry's timestamp inside the archive. */
  lastModified?: number;
}

export type ZipJobState = 'zipping' | 'done' | 'error' | 'cancelled';

export interface ZipJobView {
  filename: string;
  state: ZipJobState;
  totalFiles: number;
  filesDone: number;
  /** The file being streamed right now, for the progress card. */
  currentName: string | null;
  totalBytes: number;
  bytesDone: number;
  error?: string;
  speedBps: number;
  etaSeconds: number | null;
}

/** Where a finished archive goes. */
export interface ZipSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * Cap for the in-memory fallback. Browsers without the File System Access API
 * cannot stream to disk, so the archive has to be held whole before it is
 * handed over — fine for a batch of photos, not for raw video.
 */
export const MEMORY_ZIP_LIMIT = 1024 * 1024 * 1024;

export function supportsSavePicker(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

/** Turns a project or folder name into a usable archive filename. */
export function zipFilename(label: string): string {
  const base = label
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base === '' ? 'files' : base}.zip`;
}

function writableSink(stream: FileSystemWritableFileStream): ZipSink {
  return {
    // The cast is the SharedArrayBuffer narrowing TypeScript 5.7 added to
    // typed arrays: these chunks come from fetch and from plain allocations,
    // so they are always backed by an ordinary ArrayBuffer. Copying each one
    // to satisfy the checker would memcpy the entire archive for nothing.
    write: (chunk) => stream.write(chunk as FileSystemWriteChunkType),
    close: () => stream.close(),
    abort: () => stream.abort(),
  };
}

function memorySink(filename: string): ZipSink {
  let chunks: BlobPart[] | null = [];
  return {
    write: async (chunk) => {
      // The chunk can be a view onto a buffer the caller reuses, so copy it
      // into storage of its own before parking it until close().
      const copy = new Uint8Array(chunk.length);
      copy.set(chunk);
      chunks?.push(copy);
    },
    close: async () => {
      const blob = new Blob(chunks ?? [], { type: 'application/zip' });
      chunks = null;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      // Revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    abort: async () => {
      chunks = null;
    },
  };
}

/**
 * Asks the user where the archive should go. Must be called straight from a
 * click handler: the save picker needs transient user activation.
 */
export async function pickZipSink(filename: string, totalBytes: number): Promise<ZipSink> {
  if (supportsSavePicker()) {
    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
    });
    return writableSink(await handle.createWritable());
  }
  if (totalBytes > MEMORY_ZIP_LIMIT) {
    throw new Error(
      'This browser has to build the whole ZIP in memory, which is too much for a selection this large. Use Chrome or Edge, or select fewer files.',
    );
  }
  return memorySink(filename);
}

export interface ZipManagerConfig {
  maxAttempts: number;
  backoffBaseMs: number;
}

const DEFAULT_CONFIG: ZipManagerConfig = { maxAttempts: 5, backoffBaseMs: 1000 };

interface JobState {
  filename: string;
  state: ZipJobState;
  totalFiles: number;
  filesDone: number;
  currentName: string | null;
  totalBytes: number;
  bytesDone: number;
  error?: string;
}

export class ZipManager {
  private job: JobState | null = null;
  private controller: AbortController | null = null;
  private samples: { t: number; bytes: number }[] = [];
  private listeners = new Set<() => void>();
  // Cached immutable view: the snapshot identity must only change when
  // something actually changed, or every progress tick re-renders the tree.
  private view: ZipJobView | null = null;
  private dirty = true;

  constructor(
    private readonly api: DownloadApi,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
    private readonly config: ZipManagerConfig = DEFAULT_CONFIG,
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ZipJobView | null {
    if (!this.job) return null;
    if (this.dirty || !this.view) {
      const speedBps = this.speed();
      this.view = {
        ...this.job,
        speedBps,
        etaSeconds: speedBps > 0 ? Math.round((this.job.totalBytes - this.job.bytesDone) / speedBps) : null,
      };
      this.dirty = false;
    }
    return this.view;
  }

  get busy(): boolean {
    return this.job?.state === 'zipping';
  }

  /**
   * Starts building an archive. Returns immediately; progress and failures are
   * reported through the snapshot, the same way transfers are.
   */
  start(files: ZipTarget[], sink: ZipSink, filename: string): void {
    if (this.busy) throw new Error('A ZIP is already being built — wait for it to finish.');
    this.job = {
      filename,
      state: 'zipping',
      totalFiles: files.length,
      filesDone: 0,
      currentName: files[0]?.displayName ?? null,
      totalBytes: files.reduce((n, f) => n + f.size, 0),
      bytesDone: 0,
    };
    this.samples = [];
    this.controller = new AbortController();
    this.touch();
    void this.run([...files], sink);
  }

  /** Stops the job and discards the partial archive. */
  cancel(): void {
    this.controller?.abort();
  }

  /** Removes a finished job from the UI. */
  clear(): void {
    if (this.busy) return;
    this.job = null;
    this.view = null;
    this.touch();
  }

  // ---- internals ----

  private touch(): void {
    this.dirty = true;
    for (const l of this.listeners) l();
  }

  private patch(p: Partial<JobState>): void {
    if (!this.job) return;
    this.job = { ...this.job, ...p };
    this.touch();
  }

  private speed(): number {
    if (this.samples.length < 2) return 0;
    const cutoff = Date.now() - 10_000;
    const win = this.samples.filter((s) => s.t >= cutoff);
    const first = win[0];
    const last = win[win.length - 1];
    if (!first || !last || last.t === first.t) return 0;
    return Math.max(0, ((last.bytes - first.bytes) / (last.t - first.t)) * 1000);
  }

  private advance(bytes: number): void {
    if (!this.job) return;
    this.job.bytesDone += bytes;
    this.samples.push({ t: Date.now(), bytes: this.job.bytesDone });
    if (this.samples.length > 100) this.samples.splice(0, 50);
    this.touch();
  }

  private async run(files: ZipTarget[], sink: ZipSink): Promise<void> {
    const signal = this.controller!.signal;
    const writer = new ZipWriter((chunk) => sink.write(chunk));
    const used = new Set<string>();
    try {
      for (const f of files) {
        if (signal.aborted) throw abortError();
        this.patch({ currentName: f.displayName });
        await this.addEntry(writer, f, uniqueEntryName(used, f.displayName), signal);
        this.patch({ filesDone: (this.job?.filesDone ?? 0) + 1 });
      }
      await writer.finish();
      await sink.close();
      this.patch({ state: 'done', currentName: null, error: undefined });
    } catch (err) {
      // Nothing usable can be salvaged from a truncated archive, so the
      // partial file is thrown away rather than left looking like a download.
      await sink.abort().catch(() => {});
      if (signal.aborted || isAbortError(err)) {
        this.patch({ state: 'cancelled', currentName: null, error: undefined });
      } else {
        this.patch({
          state: 'error',
          currentName: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.controller = null;
    }
  }

  private async addEntry(writer: ZipWriter, f: ZipTarget, name: string, signal: AbortSignal): Promise<void> {
    await writer.beginFile({ name, size: f.size, lastModified: f.lastModified });
    let attempt = 0;
    while (writer.entryBytesWritten < f.size) {
      const before = writer.entryBytesWritten;
      try {
        await this.streamInto(writer, f.id, before, signal);
        if (writer.entryBytesWritten < f.size) {
          throw new TransferError('network', 'Stream ended before the file was complete');
        }
      } catch (err) {
        if (signal.aborted || isAbortError(err)) throw err;
        if (!(err instanceof TransferError) || err.kind === 'fatal') throw err;
        // Bytes since the last failure mean the link is alive, so the retry
        // budget starts over — a 40 GB clip on a flaky line should not die
        // just because it has already survived five earlier drops.
        attempt = writer.entryBytesWritten > before ? 0 : attempt + 1;
        if (attempt >= this.config.maxAttempts) throw err;
        this.patch({ error: 'Connection lost — retrying…' });
        await delay(backoffMs(attempt, this.config.backoffBaseMs), signal);
      }
    }
    if (this.job?.error) this.patch({ error: undefined });
    await writer.endFile();
  }

  private async streamInto(writer: ZipWriter, videoId: string, from: number, signal: AbortSignal): Promise<void> {
    const { url } = await this.api.downloadUrl(videoId);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: from > 0 ? { Range: `bytes=${from}-` } : {},
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new TransferError('network', 'Network error while connecting');
    }

    if (from > 0 && res.status === 200) {
      // Unlike a plain file download there is no rewinding here: the earlier
      // bytes are already inside the archive, so a whole-file response after
      // a Range request cannot be used at all.
      await res.body?.cancel().catch(() => {});
      throw new TransferError('fatal', 'Server does not support resuming (no Range support)');
    }
    if (!(res.status === 206 || (res.status === 200 && from === 0))) {
      throw new TransferError(classifyHttpStatus(res.status), `HTTP ${res.status}`);
    }
    if (!res.body) throw new TransferError('network', 'Empty response body');

    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read().catch((err: unknown) => {
        if (isAbortError(err)) throw err;
        throw new TransferError('network', 'Connection lost mid-stream');
      });
      if (done) break;
      if (value && value.byteLength > 0) {
        await writer.write(value);
        this.advance(value.byteLength);
      }
    }
  }
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
