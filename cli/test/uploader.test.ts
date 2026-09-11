import { describe, expect, it } from 'vitest';
import type { CliApi } from '../src/api.js';
import { uploadAll, type LocalFile, type PartPutter } from '../src/uploader.js';

const PART = 1024;

interface FakeUpload {
  totalParts: number;
  size: number;
  parts: Map<number, number>;
  completed: boolean;
}

function makeFake(preexisting?: { name: string; size: number; doneParts: number[] }) {
  const uploads = new Map<string, FakeUpload>();
  let counter = 0;
  const byName = new Map<string, string>();

  if (preexisting) {
    const id = `srv-${++counter}`;
    const u: FakeUpload = {
      totalParts: Math.max(1, Math.ceil(preexisting.size / PART)),
      size: preexisting.size,
      parts: new Map(preexisting.doneParts.map((n) => [n, Math.min(PART, preexisting.size - (n - 1) * PART)])),
      completed: false,
    };
    uploads.set(id, u);
    byName.set(`${preexisting.name}:${preexisting.size}`, id);
  }

  const puts: { uploadId: string; partNumber: number; iface: string | null }[] = [];

  const api: CliApi = {
    listProjects: async () => [],
    listFolders: async () => [],
    createBatch: async (_p, _f, files) => ({
      results: files.map((f) => {
        const existing = byName.get(`${f.filename}:${f.size}`);
        if (existing) {
          const u = uploads.get(existing)!;
          if (u.completed) {
            return { kind: 'duplicate' as const, filename: f.filename, videoId: `v-${existing}`, status: 'READY' as const };
          }
          return {
            kind: 'duplicate' as const,
            filename: f.filename,
            videoId: `v-${existing}`,
            status: 'UPLOADING' as const,
            uploadId: existing,
            partSize: PART,
            totalParts: u.totalParts,
          };
        }
        const id = `srv-${++counter}`;
        const totalParts = Math.max(1, Math.ceil(f.size / PART));
        uploads.set(id, { totalParts, size: f.size, parts: new Map(), completed: false });
        byName.set(`${f.filename}:${f.size}`, id);
        return { kind: 'created' as const, filename: f.filename, uploadId: id, videoId: `v-${id}`, partSize: PART, totalParts };
      }),
    }),
    status: async (uploadId) => {
      const u = uploads.get(uploadId)!;
      return {
        uploadId,
        videoId: `v-${uploadId}`,
        status: u.completed ? 'COMPLETED' : 'IN_PROGRESS',
        videoStatus: u.completed ? 'READY' : 'UPLOADING',
        partSize: PART,
        totalParts: u.totalParts,
        uploadedParts: [...u.parts.entries()].map(([partNumber, size]) => ({ partNumber, etag: `"e${partNumber}"`, size })),
      };
    },
    signPart: async (uploadId, partNumber) => `fake://${uploadId}/${partNumber}`,
    partDone: async () => {},
    complete: async (uploadId) => {
      const u = uploads.get(uploadId)!;
      for (let n = 1; n <= u.totalParts; n++) {
        if (!u.parts.has(n)) throw new Error(`missing part ${n}`);
      }
      u.completed = true;
    },
  };

  const putter: PartPutter = {
    async put(url, _file, _start, length, ifaceIp) {
      await new Promise((r) => setTimeout(r, 5));
      const m = /^fake:\/\/([^/]+)\/(\d+)$/.exec(url)!;
      const uploadId = m[1]!;
      const partNumber = Number(m[2]!);
      uploads.get(uploadId)!.parts.set(partNumber, length);
      puts.push({ uploadId, partNumber, iface: ifaceIp });
      return { etag: `"e${partNumber}"` };
    },
  };

  return { api, putter, puts, uploads };
}

const file = (name: string, size: number): LocalFile => ({ path: `/tmp/${name}`, name, size, mimeType: 'video/mp4' });
const OPTS = { perIface: 1, maxAttempts: 3, backoffBaseMs: 1 };

describe('bonded uploader', () => {
  it('spreads parts across all interfaces and completes', async () => {
    const { api, putter, puts, uploads } = makeFake();
    const summary = await uploadAll(api, putter, [file('big.mp4', PART * 8)], { projectId: 'p', folderId: null }, ['10.0.0.1', '192.168.1.5', '172.20.0.2'], OPTS);
    expect(summary.uploaded).toEqual(['big.mp4']);
    expect(summary.failed).toEqual([]);
    expect([...uploads.values()][0]!.completed).toBe(true);
    // Every interface carried at least one part; every part sent exactly once.
    const byIface = new Set(puts.map((p) => p.iface));
    expect(byIface.size).toBe(3);
    expect(puts.map((p) => p.partNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('adopts an interrupted upload and only sends missing parts', async () => {
    const { api, putter, puts, uploads } = makeFake({ name: 'phone.mp4', size: PART * 5, doneParts: [1, 2] });
    const summary = await uploadAll(api, putter, [file('phone.mp4', PART * 5)], { projectId: 'p', folderId: null }, ['10.0.0.1'], OPTS);
    expect(summary.adopted).toEqual(['phone.mp4']);
    expect(puts.map((p) => p.partNumber).sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect([...uploads.values()][0]!.completed).toBe(true);
  });

  it('skips files already uploaded and reports failures without stopping the batch', async () => {
    const fake = makeFake({ name: 'done.mp4', size: PART, doneParts: [1] });
    [...fake.uploads.values()][0]!.completed = true;
    let failFor = 'bad.mp4';
    const flakyPutter: PartPutter = {
      async put(url, f, start, length, iface) {
        if (f.name === failFor) throw new Error('interface down');
        return fake.putter.put(url, f, start, length, iface);
      },
    };
    const summary = await uploadAll(
      fake.api,
      flakyPutter,
      [file('done.mp4', PART), file('bad.mp4', PART * 2), file('good.mp4', PART)],
      { projectId: 'p', folderId: null },
      ['10.0.0.1'],
      OPTS,
    );
    expect(summary.skipped).toEqual(['done.mp4']);
    expect(summary.failed.map((f) => f.name)).toEqual(['bad.mp4']);
    expect(summary.uploaded).toEqual(['good.mp4']);

    // Re-run after the network recovers: bad.mp4 is adopted and finishes.
    failFor = '';
    const retry = await uploadAll(fake.api, flakyPutter, [file('bad.mp4', PART * 2)], { projectId: 'p', folderId: null }, ['10.0.0.1'], OPTS);
    expect(retry.adopted).toEqual(['bad.mp4']);
    expect(retry.failed).toEqual([]);
  });
});
