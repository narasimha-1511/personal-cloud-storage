import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultDb } from '../src/lib/db';
import { DownloadManager, type DownloadManagerConfig } from '../src/lib/downloadManager';
import { waitFor } from './mocks';

const FAST: DownloadManagerConfig = { checkpointBytes: 4096, maxAttempts: 4, backoffBaseMs: 1 };

/** In-memory FileSystemFileHandle good enough for the download engine. */
class FakeFileHandle {
  kind = 'file' as const;
  name: string;
  private committed = new Uint8Array(0);
  constructor(name: string) {
    this.name = name;
  }
  async getFile(): Promise<File> {
    return new File([Uint8Array.from(this.committed)], this.name);
  }
  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }
  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }
  async createWritable(opts?: { keepExistingData?: boolean }) {
    let buf = opts?.keepExistingData ? Uint8Array.from(this.committed) : new Uint8Array(0);
    let pos = 0;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async seek(position: number) {
        pos = position;
      },
      async write(chunk: Uint8Array) {
        if (pos + chunk.byteLength > buf.byteLength) {
          const grown = new Uint8Array(pos + chunk.byteLength);
          grown.set(buf);
          buf = grown;
        }
        buf.set(chunk, pos);
        pos += chunk.byteLength;
      },
      async close() {
        self.committed = buf;
      },
      async abort() {},
    };
  }
}

interface ServedRequest {
  range: string | null;
}

/** Range-aware fake object store endpoint. */
function makeServer(source: Uint8Array, opts: { cutAfterBytes?: number; ignoreRange?: boolean } = {}) {
  const requests: ServedRequest[] = [];
  let cutRemaining = opts.cutAfterBytes ?? -1;

  const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
    const signal = init?.signal;
    requests.push({ range: rangeHeader });

    let start = 0;
    let status = 200;
    if (rangeHeader && !opts.ignoreRange) {
      const m = /^bytes=(\d+)-$/.exec(rangeHeader);
      start = m ? Number(m[1]) : 0;
      status = 206;
    }
    const body = source.subarray(start);
    const chunkSize = 1024;
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) {
          controller.error(new DOMException('Aborted', 'AbortError'));
          return;
        }
        if (cutRemaining >= 0 && sent >= cutRemaining) {
          cutRemaining = -1; // only cut once; the connection "recovers" after
          controller.error(new TypeError('network cut'));
          return;
        }
        if (sent >= body.byteLength) {
          controller.close();
          return;
        }
        const chunk = body.subarray(sent, Math.min(sent + chunkSize, body.byteLength));
        sent += chunk.byteLength;
        controller.enqueue(Uint8Array.from(chunk));
      },
    });
    return new Response(stream, { status });
  }) as typeof fetch;

  return { fetchFn, requests };
}

function makeSource(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = i % 251;
  return buf;
}

let dbCounter = 0;
const dbs: VaultDb[] = [];
function newDb(): VaultDb {
  const db = new VaultDb(`dl-test-${Date.now()}-${++dbCounter}`);
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const video = (size: number) => ({ id: 'vid-1', displayName: 'VID_2038.MP4', size });

async function fileBytes(handle: FakeFileHandle): Promise<Uint8Array> {
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

describe('DownloadManager', () => {
  it('downloads a file to disk via streaming writes', async () => {
    const source = makeSource(10_000);
    const { fetchFn, requests } = makeServer(source);
    const mgr = new DownloadManager(newDb(), { downloadUrl: async () => ({ url: 'mock://dl' }) }, fetchFn, FAST);
    await mgr.init();
    const handle = new FakeFileHandle('VID_2038.MP4');
    await mgr.start(video(source.byteLength), handle as unknown as FileSystemFileHandle);

    await waitFor(() => mgr.snapshot()[0]?.state === 'done', 5000, 'download done');
    expect(await fileBytes(handle)).toEqual(source);
    expect(requests[0]!.range).toBeNull();
  });

  it('resumes from the interruption point with a Range request — never from zero', async () => {
    const source = makeSource(50_000);
    const { fetchFn, requests } = makeServer(source, { cutAfterBytes: 20_000 });
    const mgr = new DownloadManager(newDb(), { downloadUrl: async () => ({ url: 'mock://dl' }) }, fetchFn, FAST);
    await mgr.init();
    const handle = new FakeFileHandle('VID_2038.MP4');
    await mgr.start(video(source.byteLength), handle as unknown as FileSystemFileHandle);

    await waitFor(() => mgr.snapshot()[0]?.state === 'done', 5000, 'download done after cut');
    expect(await fileBytes(handle)).toEqual(source);

    expect(requests.length).toBeGreaterThan(1);
    const second = requests[1]!;
    expect(second.range).toMatch(/^bytes=\d+-$/);
    const resumedFrom = Number(/^bytes=(\d+)-$/.exec(second.range!)![1]);
    // Resumed from committed progress: more than zero, less than the whole file.
    expect(resumedFrom).toBeGreaterThan(0);
    expect(resumedFrom).toBeLessThan(source.byteLength);
  });

  it('fails safely if the server ignores Range instead of rewriting the file', async () => {
    const source = makeSource(30_000);
    // First connection cut at 10k, then the server "forgets" Range support.
    const { fetchFn } = makeServer(source, { cutAfterBytes: 10_000, ignoreRange: true });
    const mgr = new DownloadManager(newDb(), { downloadUrl: async () => ({ url: 'mock://dl' }) }, fetchFn, FAST);
    await mgr.init();
    const handle = new FakeFileHandle('VID.MP4');
    await mgr.start(video(source.byteLength), handle as unknown as FileSystemFileHandle);

    await waitFor(() => mgr.snapshot()[0]?.state === 'error', 5000, 'error state');
    expect(mgr.snapshot()[0]!.error).toMatch(/does not support resuming/);
  });

  it('pause commits progress; resume picks up from the on-disk size', async () => {
    const source = makeSource(100_000);
    const { fetchFn, requests } = makeServer(source);
    const db = newDb();
    const mgr = new DownloadManager(db, { downloadUrl: async () => ({ url: 'mock://dl' }) }, fetchFn, FAST);
    await mgr.init();
    const handle = new FakeFileHandle('VID.MP4');
    await mgr.start(video(source.byteLength), handle as unknown as FileSystemFileHandle);

    await waitFor(() => (mgr.snapshot()[0]?.bytesWritten ?? 0) > 8_192, 5000, 'some progress');
    mgr.pause('vid-1');
    await waitFor(() => mgr.snapshot()[0]?.state === 'paused', 5000, 'paused');
    const requestsAtPause = requests.length;

    const result = await mgr.resume('vid-1');
    expect(result).toBe('ok');
    await waitFor(() => mgr.snapshot()[0]?.state === 'done', 5000, 'done after resume');
    expect(await fileBytes(handle)).toEqual(source);
    // The resume request continued from a byte offset, not from scratch.
    const resumeReq = requests[requestsAtPause]!;
    expect(resumeReq.range).toMatch(/^bytes=\d+-$/);
  });

  it('exhausted retries end in waiting_network with progress intact', async () => {
    const source = makeSource(20_000);
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      throw new TypeError('offline');
    }) as typeof fetch;
    const mgr = new DownloadManager(newDb(), { downloadUrl: async () => ({ url: 'mock://dl' }) }, fetchFn, FAST);
    await mgr.init();
    const handle = new FakeFileHandle('VID.MP4');
    await mgr.start(video(source.byteLength), handle as unknown as FileSystemFileHandle);

    await waitFor(() => mgr.snapshot()[0]?.state === 'waiting_network', 5000, 'waiting_network');
    expect(calls).toBe(FAST.maxAttempts);
  });
});
