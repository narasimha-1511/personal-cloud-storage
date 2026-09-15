import { describe, expect, it } from 'vitest';
import { ZipManager, zipFilename, type ZipSink, type ZipTarget } from '../src/lib/zipManager';
import { concat, noise, unzipAll } from './archive';
import { waitFor } from './mocks';

/**
 * The manager is the part that has to survive a bad connection: it streams
 * straight into a forward-only archive, so a dropped request must continue
 * with a Range from the exact byte the ZIP reached, never from zero and never
 * by writing the same bytes twice.
 */

interface RequestRecord {
  id: string;
  range: string | null;
}

class FakeR2 {
  readonly files = new Map<string, Uint8Array>();
  readonly requests: RequestRecord[] = [];
  /** Cuts the stream this many bytes into the next response, once. */
  cutAfter: number | null = null;
  /** Serves the whole file even when a Range was asked for. */
  ignoreRange = false;
  /** Status to answer the next request with, instead of the data. */
  failWith: number | null = null;
  /** Stalls the stream once this many bytes are out, until `release()`. */
  holdAfter: number | null = null;
  chunkSize = 64;

  private openGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.openGate = resolve;
  });

  /** Lets a held stream continue. Once released it stays released. */
  release(): void {
    this.openGate();
  }

  add(id: string, data: Uint8Array): ZipTarget {
    this.files.set(id, data);
    return { id, displayName: `${id}.bin`, size: data.length };
  }

  readonly api = {
    downloadUrl: async (videoId: string) => ({ url: `mock://r2/${videoId}` }),
  };

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const id = String(input).split('/').pop()!;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const range = headers.Range ?? null;
    this.requests.push({ id, range });

    if (this.failWith !== null) {
      const status = this.failWith;
      this.failWith = null;
      return new Response(null, { status });
    }

    const data = this.files.get(id)!;
    const from = range && !this.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    const served = data.subarray(from);
    const cut = this.cutAfter;
    this.cutAfter = null;

    let at = 0;
    const chunkSize = this.chunkSize;
    const signal = init?.signal ?? null;
    const hold = this.holdAfter;
    const gate = this.gate;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Parking the stream mid-file is what makes "cancel half way" a fact
        // rather than a race against how fast the loop happens to run.
        if (hold !== null && at >= hold) await gate;
        if (signal?.aborted) {
          controller.error(new DOMException('Aborted', 'AbortError'));
          return;
        }
        if (cut !== null && at >= cut) {
          controller.error(new Error('connection reset by peer'));
          return;
        }
        if (at >= served.length) {
          controller.close();
          return;
        }
        const end = Math.min(at + chunkSize, served.length);
        controller.enqueue(served.subarray(at, end));
        at = end;
      },
    });
    // 206 whenever a Range was honoured, exactly like R2 does.
    return new Response(body, { status: range && !this.ignoreRange ? 206 : 200 });
  }) as typeof fetch;
}

function collectingSink(): ZipSink & { chunks: Uint8Array[]; closed: boolean; aborted: boolean } {
  const sink = {
    chunks: [] as Uint8Array[],
    closed: false,
    aborted: false,
    write: async (chunk: Uint8Array) => {
      const copy = new Uint8Array(chunk.length);
      copy.set(chunk);
      sink.chunks.push(copy);
    },
    close: async () => {
      sink.closed = true;
    },
    abort: async () => {
      sink.aborted = true;
    },
  };
  return sink;
}

function manager(r2: FakeR2): ZipManager {
  return new ZipManager(r2.api, r2.fetch, { maxAttempts: 5, backoffBaseMs: 1 });
}

describe('zipFilename', () => {
  it('turns a folder name into a safe archive name', () => {
    expect(zipFilename('Day 1')).toBe('Day 1.zip');
    expect(zipFilename('Drone / B-roll')).toBe('Drone B-roll.zip');
    expect(zipFilename('  ')).toBe('files.zip');
  });
});

describe('ZipManager', () => {
  it('packs every selected file into one archive, byte for byte', async () => {
    const r2 = new FakeR2();
    const targets = [
      r2.add('clip', noise(5000, 3)),
      r2.add('photo', noise(700, 9)),
      r2.add('blank', new Uint8Array(0)),
    ];
    const sink = collectingSink();
    const zip = manager(r2);

    zip.start(targets, sink, 'Day 1.zip');
    await waitFor(() => zip.snapshot()?.state === 'done', 5000, 'the ZIP to finish');

    expect(sink.closed).toBe(true);
    const entries = await unzipAll(concat(sink.chunks));
    expect([...entries.keys()]).toEqual(['clip.bin', 'photo.bin', 'blank.bin']);
    expect(entries.get('clip.bin')).toEqual(r2.files.get('clip'));
    expect(entries.get('photo.bin')).toEqual(r2.files.get('photo'));
    expect(entries.get('blank.bin')!.length).toBe(0);

    const view = zip.snapshot()!;
    expect(view.filesDone).toBe(3);
    expect(view.bytesDone).toBe(view.totalBytes);
    expect(view.currentName).toBeNull();
  });

  it('resumes a cut transfer from the byte the archive reached, not from zero', async () => {
    const r2 = new FakeR2();
    const target = r2.add('clip', noise(5000, 11));
    r2.cutAfter = 1024; // die partway through the first response
    const sink = collectingSink();
    const zip = manager(r2);

    zip.start([target], sink, 'a.zip');
    await waitFor(() => zip.snapshot()?.state === 'done', 5000, 'the ZIP to finish');

    expect(r2.requests).toHaveLength(2);
    expect(r2.requests[0]!.range).toBeNull();
    // Whatever whole chunks made it through are already in the archive; the
    // retry must ask for exactly the remainder.
    expect(r2.requests[1]!.range).toMatch(/^bytes=\d+-$/);
    const resumedFrom = Number(/bytes=(\d+)-/.exec(r2.requests[1]!.range!)![1]);
    expect(resumedFrom).toBeGreaterThan(0);
    expect(resumedFrom).toBeLessThan(5000);

    const entries = await unzipAll(concat(sink.chunks));
    expect(entries.get('clip.bin')).toEqual(r2.files.get('clip'));
  });

  it('keeps retrying across repeated drops as long as it is making progress', async () => {
    const r2 = new FakeR2();
    const data = noise(4000, 5);
    const target = r2.add('clip', data);
    const sink = collectingSink();

    // More drops than maxAttempts: each one advances, so the budget resets.
    let drops = 0;
    const originalFetch = r2.fetch;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (drops < 8) {
        drops++;
        r2.cutAfter = 300;
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    const flakyZip = new ZipManager(r2.api, flaky, { maxAttempts: 5, backoffBaseMs: 1 });

    flakyZip.start([target], sink, 'a.zip');
    await waitFor(() => flakyZip.snapshot()?.state === 'done', 5000, 'the ZIP to finish');

    expect(drops).toBe(8);
    const entries = await unzipAll(concat(sink.chunks));
    expect(entries.get('clip.bin')).toEqual(data);
  });

  it('gives up when retries make no progress at all', async () => {
    const r2 = new FakeR2();
    const target = r2.add('clip', noise(2000, 7));
    const sink = collectingSink();
    // Every response dies before a single byte arrives.
    const dead = (async (input: RequestInfo | URL, init?: RequestInit) => {
      r2.cutAfter = 0;
      return r2.fetch(input, init);
    }) as typeof fetch;
    const zip = new ZipManager(r2.api, dead, { maxAttempts: 3, backoffBaseMs: 1 });

    zip.start([target], sink, 'a.zip');
    await waitFor(() => zip.snapshot()?.state === 'error', 5000, 'the ZIP to fail');

    expect(sink.aborted).toBe(true);
    expect(sink.closed).toBe(false);
    expect(r2.requests).toHaveLength(3);
  });

  it('fails instead of corrupting the archive when the server ignores Range', async () => {
    const r2 = new FakeR2();
    const target = r2.add('clip', noise(3000, 13));
    r2.cutAfter = 512;
    r2.ignoreRange = true; // the retry gets the whole file back, from byte 0
    const sink = collectingSink();
    const zip = manager(r2);

    zip.start([target], sink, 'a.zip');
    await waitFor(() => zip.snapshot()?.state === 'error', 5000, 'the ZIP to fail');

    expect(zip.snapshot()!.error).toMatch(/does not support resuming/);
    expect(sink.aborted).toBe(true);
  });

  it('stops on a fatal HTTP status rather than retrying it', async () => {
    const r2 = new FakeR2();
    const target = r2.add('clip', noise(100, 2));
    r2.failWith = 404;
    const sink = collectingSink();
    const zip = manager(r2);

    zip.start([target], sink, 'a.zip');
    await waitFor(() => zip.snapshot()?.state === 'error', 5000, 'the ZIP to fail');

    expect(r2.requests).toHaveLength(1);
    expect(zip.snapshot()!.error).toContain('404');
  });

  it('discards the partial archive when cancelled', async () => {
    const r2 = new FakeR2();
    r2.holdAfter = 256;
    const targets = [r2.add('a', noise(20_000, 1)), r2.add('b', noise(20_000, 2))];
    const sink = collectingSink();
    const zip = manager(r2);

    zip.start(targets, sink, 'a.zip');
    await waitFor(() => (zip.snapshot()?.bytesDone ?? 0) > 0, 5000, 'the ZIP to start moving');
    zip.cancel();
    r2.release();
    await waitFor(() => zip.snapshot()?.state === 'cancelled', 5000, 'the ZIP to stop');

    expect(sink.aborted).toBe(true);
    expect(sink.closed).toBe(false);
    expect(zip.busy).toBe(false);
    expect(zip.snapshot()!.bytesDone).toBeLessThan(zip.snapshot()!.totalBytes);
  });

  it('gives duplicate display names separate entries', async () => {
    const r2 = new FakeR2();
    const first = { ...r2.add('one', noise(120, 4)), displayName: 'DJI_0001.JPG' };
    const second = { ...r2.add('two', noise(340, 6)), displayName: 'DJI_0001.JPG' };
    const sink = collectingSink();
    const zip = manager(r2);

    zip.start([first, second], sink, 'a.zip');
    await waitFor(() => zip.snapshot()?.state === 'done', 5000, 'the ZIP to finish');

    const entries = await unzipAll(concat(sink.chunks));
    expect([...entries.keys()]).toEqual(['DJI_0001.JPG', 'DJI_0001 (2).JPG']);
    expect(entries.get('DJI_0001.JPG')).toEqual(r2.files.get('one'));
    expect(entries.get('DJI_0001 (2).JPG')).toEqual(r2.files.get('two'));
  });

  it('refuses to run two archives at once, and clears only when idle', async () => {
    const r2 = new FakeR2();
    r2.holdAfter = 256;
    const target = r2.add('a', noise(20_000, 1));
    const sink = collectingSink();
    const zip = manager(r2);

    zip.start([target], sink, 'a.zip');
    expect(zip.busy).toBe(true);
    expect(() => zip.start([target], collectingSink(), 'b.zip')).toThrow(/already being built/);
    // Clearing a running job must not wipe the card out from under it.
    zip.clear();
    expect(zip.snapshot()).not.toBeNull();

    zip.cancel();
    r2.release();
    await waitFor(() => zip.snapshot()?.state === 'cancelled', 5000, 'the ZIP to stop');
    zip.clear();
    expect(zip.snapshot()).toBeNull();
  });

  it('reports progress a pill can render', async () => {
    const r2 = new FakeR2();
    const targets = [r2.add('a', noise(1000, 1)), r2.add('b', noise(3000, 2))];
    const sink = collectingSink();
    const zip = manager(r2);

    zip.start(targets, sink, 'Day 1.zip');
    const started = zip.snapshot()!;
    expect(started.filename).toBe('Day 1.zip');
    expect(started.totalFiles).toBe(2);
    expect(started.totalBytes).toBe(4000);
    expect(started.state).toBe('zipping');

    await waitFor(() => zip.snapshot()?.state === 'done', 5000, 'the ZIP to finish');
    expect(zip.snapshot()!.bytesDone).toBe(4000);
  });
});
