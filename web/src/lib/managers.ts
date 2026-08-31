import { useSyncExternalStore } from 'react';
import { api } from './api';
import { db } from './db';
import { UploadManager, type UploadView } from './uploadManager';
import { DownloadManager, type DownloadView } from './downloadManager';
import { XhrPartTransport } from './transport';

export const uploadManager = new UploadManager(db, api, new XhrPartTransport());
export const downloadManager = new DownloadManager(db, api);

let initPromise: Promise<void> | null = null;
export function ensureManagersInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Promise.all([uploadManager.init(), downloadManager.init()]).then(() => {});
  }
  return initPromise;
}

/** Throttled external-store bridge: progress events fire very often. */
function createStore<T>(onChange: (cb: () => void) => () => void, compute: () => T) {
  let cached = compute();
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const subs = new Set<() => void>();

  const flush = () => {
    timer = null;
    if (!dirty) return;
    dirty = false;
    cached = compute();
    for (const s of subs) s();
  };

  onChange(() => {
    dirty = true;
    if (!timer) {
      cached = compute();
      for (const s of subs) s();
      dirty = false;
      timer = setTimeout(flush, 250);
    }
  });

  return {
    subscribe: (cb: () => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    getSnapshot: () => cached,
  };
}

const uploadStore = createStore<UploadView[]>(
  (cb) => uploadManager.onChange(cb),
  () => uploadManager.snapshot(),
);
const downloadStore = createStore<DownloadView[]>(
  (cb) => downloadManager.onChange(cb),
  () => downloadManager.snapshot(),
);

export function useUploads(): UploadView[] {
  return useSyncExternalStore(uploadStore.subscribe, uploadStore.getSnapshot);
}

export function useDownloads(): DownloadView[] {
  return useSyncExternalStore(downloadStore.subscribe, downloadStore.getSnapshot);
}
