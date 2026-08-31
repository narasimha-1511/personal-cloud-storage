import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultDb } from '../src/lib/db';
import { UploadManager, type UploadManagerConfig } from '../src/lib/uploadManager';
import { MockBackend, makeFile, waitFor } from './mocks';

const FAST: UploadManagerConfig = {
  concurrency: 2,
  maxAttempts: 3,
  partTimeoutMs: 1000,
  heartbeatMs: 20,
  backoffBaseMs: 1,
};

let dbCounter = 0;
const managers: UploadManager[] = [];
const dbs: VaultDb[] = [];

function newDbName(): string {
  return `vault-test-${Date.now()}-${++dbCounter}`;
}

function makeManager(backend: MockBackend, dbName: string, config = FAST) {
  const db = new VaultDb(dbName);
  const mgr = new UploadManager(db, backend.api, backend.transport, config);
  managers.push(mgr);
  dbs.push(db);
  return { db, mgr };
}

afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
  for (const d of dbs.splice(0)) d.close();
});

function stateOf(mgr: UploadManager, localId: string) {
  return mgr.snapshot().find((v) => v.localId === localId);
}

describe('UploadManager', () => {
  it('uploads a multi-part file end to end', async () => {
    const backend = new MockBackend();
    const { mgr } = makeManager(backend, newDbName());
    await mgr.init();

    const file = makeFile(backend.partSize * 4 + 100); // 5 parts
    const localId = await mgr.addFile(file, { projectId: 'p1' });

    await waitFor(() => stateOf(mgr, localId)?.state === 'done', 5000, 'upload done');
    expect(backend.putsReceived.map((p) => p.partNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    const view = stateOf(mgr, localId)!;
    expect(view.bytesUploaded).toBe(file.size);
    expect(view.partsDone).toBe(5);
  });

  it('never exceeds the configured part concurrency', async () => {
    const backend = new MockBackend();
    const { mgr } = makeManager(backend, newDbName());
    await mgr.init();
    const file = makeFile(backend.partSize * 10);
    const localId = await mgr.addFile(file, { projectId: 'p1' });
    await waitFor(() => stateOf(mgr, localId)?.state === 'done', 5000, 'upload done');
    expect(backend.maxConcurrentPuts).toBeGreaterThan(0);
    expect(backend.maxConcurrentPuts).toBeLessThanOrEqual(2);
  });

  it('retries transient failures with backoff and recovers', async () => {
    const backend = new MockBackend();
    // First 2 PUT attempts fail, then the network "recovers".
    let failures = 0;
    const origPut = backend.transport.putPart.bind(backend.transport);
    backend.transport = {
      putPart: async (url, body, opts) => {
        if (failures < 2) {
          failures++;
          throw new (await import('../src/lib/network')).TransferError('network', 'flaky');
        }
        return origPut(url, body, opts);
      },
    };
    const { mgr } = makeManager(backend, newDbName());
    await mgr.init();
    const file = makeFile(backend.partSize * 3);
    const localId = await mgr.addFile(file, { projectId: 'p1' });
    await waitFor(() => stateOf(mgr, localId)?.state === 'done', 5000, 'upload done');
    expect(failures).toBe(2);
  });

  it('pauses after retries are exhausted instead of destroying progress, then resumes', async () => {
    const backend = new MockBackend();
    backend.failPutsAfter = 2; // parts 1-2 land, then the network dies
    const { mgr } = makeManager(backend, newDbName());
    await mgr.init();
    const file = makeFile(backend.partSize * 5);
    const localId = await mgr.addFile(file, { projectId: 'p1' });

    await waitFor(() => stateOf(mgr, localId)?.state === 'waiting_network', 5000, 'waiting_network');
    expect(stateOf(mgr, localId)!.partsDone).toBe(2);

    // Connectivity returns; the heartbeat notices and resumes automatically.
    backend.failPutsAfter = -1;
    await waitFor(() => stateOf(mgr, localId)?.state === 'done', 5000, 'auto-resume to done');

    // Every part was uploaded exactly once — including 1-2 from before the cut.
    const counts = new Map<number, number>();
    for (const p of backend.putsReceived) counts.set(p.partNumber, (counts.get(p.partNumber) ?? 0) + 1);
    for (let n = 1; n <= 5; n++) expect(counts.get(n), `part ${n}`).toBe(1);
  });

  it('manual pause aborts in-flight work and resume uploads only missing parts', async () => {
    const backend = new MockBackend();
    const { mgr } = makeManager(backend, newDbName());
    await mgr.init();
    const file = makeFile(backend.partSize * 20);
    const localId = await mgr.addFile(file, { projectId: 'p1' });

    await waitFor(() => (stateOf(mgr, localId)?.partsDone ?? 0) >= 3, 5000, 'some parts done');
    await mgr.pause(localId);
    await waitFor(() => stateOf(mgr, localId)?.state === 'paused', 5000, 'paused');
    // A part already in flight when pause hit may still land on R2 and be
    // recorded (correctly). Wait until the counts stop moving before sampling.
    let settled = 0;
    await waitFor(() => {
      const now = backend.putsReceived.length;
      const stable = now === settled;
      settled = now;
      return stable;
    }, 5000, 'puts settled');
    const doneAtPause = stateOf(mgr, localId)!.partsDone;
    const putsAtPause = backend.putsReceived.length;
    expect(doneAtPause).toBe(putsAtPause);

    await mgr.resume(localId);
    await waitFor(() => stateOf(mgr, localId)?.state === 'done', 5000, 'done after resume');

    // No part that was done at pause time was uploaded again.
    const after = backend.putsReceived.slice(putsAtPause).map((p) => p.partNumber);
    const uniqueAfter = new Set(after);
    expect(uniqueAfter.size).toBe(after.length); // no duplicates after resume
    expect(after.length).toBe(20 - doneAtPause);
  });

  it('abort cancels server-side and clears local part state', async () => {
    const backend = new MockBackend();
    backend.failPutsAfter = 2;
    const { mgr } = makeManager(backend, newDbName());
    await mgr.init();
    const file = makeFile(backend.partSize * 5);
    const localId = await mgr.addFile(file, { projectId: 'p1' });
    await waitFor(() => stateOf(mgr, localId)?.state === 'waiting_network', 5000, 'waiting');
    backend.networkDown = false;
    backend.failPutsAfter = -1;
    await mgr.abort(localId);
    expect(stateOf(mgr, localId)?.state).toBe('aborted');
    expect([...backend.uploads.values()][0]!.status).toBe('ABORTED');
  });

  it('queues multiple files and transfers one at a time', async () => {
    const backend = new MockBackend();
    const { mgr } = makeManager(backend, newDbName());
    await mgr.init();
    const a = await mgr.addFile(makeFile(backend.partSize * 3, 'VID_A.MP4'), { projectId: 'p1' });
    const b = await mgr.addFile(makeFile(backend.partSize * 3, 'VID_B.MP4'), { projectId: 'p1' });
    await waitFor(
      () => stateOf(mgr, a)?.state === 'done' && stateOf(mgr, b)?.state === 'done',
      5000,
      'both done',
    );
    // Interleaving check: all of A's parts arrive before any of B's.
    const uploadIds = backend.putsReceived.map((p) => p.uploadId);
    const firstB = uploadIds.indexOf('srv-2');
    const lastA = uploadIds.lastIndexOf('srv-1');
    expect(firstB === -1 || lastA < firstB).toBe(true);
  });
});

describe('resume across restart (the core invariant)', () => {
  it('uploads 100 parts, dies at 47, restarts, and uploads ONLY parts 48-100', async () => {
    const backend = new MockBackend();
    backend.failPutsAfter = 47;
    const dbName = newDbName();

    // --- session 1: upload until the network dies ---
    {
      const { mgr, db } = makeManager(backend, dbName, { ...FAST, concurrency: 1 });
      await mgr.init();
      const file = makeFile(backend.partSize * 100);
      const localId = await mgr.addFile(file, { projectId: 'p1' });
      await waitFor(() => stateOf(mgr, localId)?.state === 'waiting_network', 10_000, 'network death');
      expect(stateOf(mgr, localId)!.partsDone).toBe(47);
      // Simulate the browser/tab being killed.
      mgr.dispose();
      db.close();
    }

    const putsBeforeRestart = backend.putsReceived.length;
    expect(putsBeforeRestart).toBe(47);
    backend.failPutsAfter = -1; // network is back

    // --- session 2: fresh manager, same IndexedDB ---
    {
      const { mgr } = makeManager(backend, dbName, { ...FAST, concurrency: 1 });
      await mgr.init();
      const view = mgr.snapshot()[0]!;
      expect(view.state).toBe('needs_file');
      expect(view.partsDone).toBe(47);

      // The user re-picks the same file (identity must match).
      const file = makeFile(backend.partSize * 100);
      await mgr.provideFile(view.localId, file);
      await waitFor(() => stateOf(mgr, view.localId)?.state === 'done', 10_000, 'done after restart');
    }

    // THE invariant: parts 1-47 were never uploaded again.
    const afterRestart = backend.putsReceived.slice(putsBeforeRestart);
    const reuploaded = afterRestart.filter((p) => p.partNumber <= 47);
    expect(reuploaded).toEqual([]);
    expect(afterRestart.map((p) => p.partNumber).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 53 }, (_, i) => i + 48),
    );
    // And every part was uploaded exactly once across both sessions.
    const counts = new Map<number, number>();
    for (const p of backend.putsReceived) counts.set(p.partNumber, (counts.get(p.partNumber) ?? 0) + 1);
    for (let n = 1; n <= 100; n++) expect(counts.get(n), `part ${n}`).toBe(1);
    expect([...backend.uploads.values()][0]!.status).toBe('COMPLETED');
  });

  it('rejects a different file on resume', async () => {
    const backend = new MockBackend();
    backend.failPutsAfter = 3;
    const dbName = newDbName();
    {
      const { mgr, db } = makeManager(backend, dbName);
      await mgr.init();
      const localId = await mgr.addFile(makeFile(backend.partSize * 10), { projectId: 'p1' });
      await waitFor(() => stateOf(mgr, localId)?.state === 'waiting_network', 5000, 'network death');
      mgr.dispose();
      db.close();
    }
    backend.failPutsAfter = -1;
    const { mgr } = makeManager(backend, dbName);
    await mgr.init();
    const view = mgr.snapshot()[0]!;
    // Wrong size
    await expect(mgr.provideFile(view.localId, makeFile(backend.partSize * 9))).rejects.toThrow(/not the same file/);
    // Wrong lastModified
    await expect(
      mgr.provideFile(view.localId, makeFile(backend.partSize * 10, 'VID_2038.MP4', 999)),
    ).rejects.toThrow(/not the same file/);
  });

  it('re-uploads parts the server reports missing at complete time (corrupt state self-heal)', async () => {
    const backend = new MockBackend();
    // Sabotage: R2 "loses" part 3 the first time it is stored, so the first
    // complete attempt gets a 409 with missingParts=[3].
    let sabotaged = false;
    const origPut = backend.transport.putPart.bind(backend.transport);
    backend.transport = {
      putPart: async (url, body, opts) => {
        const res = await origPut(url, body, opts);
        if (!sabotaged && url.endsWith('/3')) {
          sabotaged = true;
          [...backend.uploads.values()][0]!.parts.delete(3);
        }
        return res;
      },
    };
    const { mgr } = makeManager(backend, newDbName());
    await mgr.init();
    const localId = await mgr.addFile(makeFile(backend.partSize * 5), { projectId: 'p1' });
    await waitFor(() => stateOf(mgr, localId)?.state === 'done', 5000, 'done after self-heal');

    // Part 3 was uploaded twice (once lost), everything else exactly once.
    const counts = new Map<number, number>();
    for (const p of backend.putsReceived) counts.set(p.partNumber, (counts.get(p.partNumber) ?? 0) + 1);
    expect(counts.get(3)).toBe(2);
    for (const n of [1, 2, 4, 5]) expect(counts.get(n), `part ${n}`).toBe(1);
    expect([...backend.uploads.values()][0]!.status).toBe('COMPLETED');
  });

  it('detects an upload completed server-side while the client was away', async () => {
    const backend = new MockBackend();
    const dbName = newDbName();
    let localId: string;
    {
      const { mgr, db } = makeManager(backend, dbName);
      await mgr.init();
      backend.failPutsAfter = 2;
      localId = await mgr.addFile(makeFile(backend.partSize * 3), { projectId: 'p1' });
      await waitFor(() => stateOf(mgr, localId)?.state === 'waiting_network', 5000, 'waiting');
      mgr.dispose();
      db.close();
    }
    // Server-side, the upload somehow finished (e.g. another device resumed it).
    backend.failPutsAfter = -1;
    const srv = [...backend.uploads.keys()][0]!;
    const u = backend.uploads.get(srv)!;
    for (let n = 1; n <= 3; n++) {
      if (!u.parts.has(n)) u.parts.set(n, { etag: `"e${n}"`, size: backend.partSize });
    }
    await backend.api.completeUpload(srv);

    const { mgr } = makeManager(backend, dbName);
    await mgr.init();
    expect(stateOf(mgr, localId)?.state).toBe('done');
  });
});

describe('bulk add', () => {
  it('queues 100 picked files with a single registration request and uploads them all', async () => {
    const backend = new MockBackend();
    const { mgr } = makeManager(backend, newDbName());
    await mgr.init();

    const files = Array.from({ length: 100 }, (_, i) =>
      makeFile(backend.partSize, `VID_${2000 + i}.MP4`),
    );
    const before = backend.apiCalls;
    const localIds = await mgr.addFiles(files.map((file) => ({ file })), { projectId: 'p1' });
    // Registration is one batched call, not one per file.
    expect(backend.apiCalls - before).toBe(1);
    expect(localIds).toHaveLength(100);
    // Everything is visible in the queue immediately.
    expect(mgr.snapshot()).toHaveLength(100);

    await waitFor(() => mgr.snapshot().every((v) => v.state === 'done'), 30_000, 'all 100 done');
    expect([...backend.uploads.values()].every((u) => u.status === 'COMPLETED')).toBe(true);
  });
});

describe('render performance', () => {
  it('snapshot keeps identical view objects for unchanged uploads', async () => {
    const backend = new MockBackend();
    const { mgr } = makeManager(backend, newDbName());
    await mgr.init();
    const a = await mgr.addFile(makeFile(backend.partSize, 'A.MP4'), { projectId: 'p1' });
    await waitFor(() => stateOf(mgr, a)?.state === 'done', 5000, 'a done');

    const before = mgr.snapshot().find((v) => v.localId === a)!;
    // Unrelated activity: a second upload starts and progresses.
    const b = await mgr.addFile(makeFile(backend.partSize * 3, 'B.MP4'), { projectId: 'p1' });
    const during = mgr.snapshot().find((v) => v.localId === a)!;
    // A's view is the exact same object, so a memoized row skips re-render.
    expect(during).toBe(before);
    await waitFor(() => stateOf(mgr, b)?.state === 'done', 5000, 'b done');
    expect(mgr.snapshot().find((v) => v.localId === a)!).toBe(before);
  });
});
