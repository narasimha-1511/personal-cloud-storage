import type { CliApi } from './api.js';

/**
 * Bonded multipart uploader: parts of each file are distributed across every
 * usable network interface via work-stealing, so a fast link naturally takes
 * more parts and the aggregate throughput is (sum of all links). Resume falls
 * out of the server design: re-running adopts in-progress uploads and asks
 * ListParts which parts are still missing.
 */

export interface LocalFile {
  path: string;
  name: string;
  size: number;
  mimeType: string;
}

export interface PartPutter {
  /** PUT one byte range of a local file via the given interface (null = OS default). */
  put(url: string, file: LocalFile, start: number, length: number, ifaceIp: string | null): Promise<{ etag: string }>;
}

export interface UploadPlanItem {
  file: LocalFile;
  uploadId: string;
  partSize: number;
  totalParts: number;
  adopted: boolean;
}

export interface Progress {
  file: string;
  fileIndex: number;
  fileCount: number;
  bytesDone: number;
  bytesTotal: number;
  byIface: Map<string, number>;
}

export interface UploaderOptions {
  perIface: number;
  maxAttempts: number;
  backoffBaseMs: number;
  onProgress?: (p: Progress) => void;
}

export interface UploadSummary {
  uploaded: string[];
  adopted: string[];
  skipped: string[];
  failed: { name: string; error: string }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Registers files (dedup + adoption included) and returns the work plan. */
export async function planUploads(
  api: CliApi,
  files: LocalFile[],
  target: { projectId: string; folderId: string | null },
): Promise<{ plan: UploadPlanItem[]; skipped: string[] }> {
  const plan: UploadPlanItem[] = [];
  const skipped: string[] = [];
  const CHUNK = 500;
  for (let i = 0; i < files.length; i += CHUNK) {
    const chunk = files.slice(i, i + CHUNK);
    const { results } = await api.createBatch(
      target.projectId,
      target.folderId,
      chunk.map((f) => ({ filename: f.name, size: f.size, mimeType: f.mimeType })),
    );
    if (!Array.isArray(results)) throw new Error('Server too old for this CLI — update the deployment');
    for (let idx = 0; idx < chunk.length; idx++) {
      const r = results[idx];
      const file = chunk[idx]!;
      if (!r) continue;
      if (r.kind === 'created') {
        plan.push({ file, uploadId: r.uploadId, partSize: r.partSize, totalParts: r.totalParts, adopted: false });
      } else if (r.status === 'UPLOADING' && r.uploadId && r.partSize && r.totalParts) {
        plan.push({ file, uploadId: r.uploadId, partSize: r.partSize, totalParts: r.totalParts, adopted: true });
      } else {
        skipped.push(file.name);
      }
    }
  }
  return { plan, skipped };
}

/** Uploads one planned file: missing parts spread across all interfaces. */
async function uploadOne(
  api: CliApi,
  putter: PartPutter,
  item: UploadPlanItem,
  ifaces: (string | null)[],
  opts: UploaderOptions,
  report: (bytes: number, iface: string | null) => void,
): Promise<void> {
  // The server's ListParts is authoritative: never re-upload a finished part.
  const status = await api.status(item.uploadId);
  const done = new Set(status.uploadedParts.map((p) => p.partNumber));
  for (const p of status.uploadedParts) report(p.size, null);

  const queue: number[] = [];
  for (let n = 1; n <= item.totalParts; n++) if (!done.has(n)) queue.push(n);

  let fatal: string | null = null;

  const worker = async (ifaceIp: string | null): Promise<void> => {
    for (;;) {
      if (fatal) return;
      const partNumber = queue.shift();
      if (partNumber === undefined) return;
      const start = (partNumber - 1) * item.partSize;
      const length = Math.min(item.partSize, item.file.size - start);

      let lastError = 'unknown';
      let ok = false;
      for (let attempt = 0; attempt < opts.maxAttempts && !fatal; attempt++) {
        try {
          // Fresh URL every attempt — also covers expiry after long stalls.
          const url = await api.signPart(item.uploadId, partNumber);
          const { etag } = await putter.put(url, item.file, start, length, ifaceIp);
          await api.partDone(item.uploadId, partNumber, etag, length).catch(() => {});
          report(length, ifaceIp);
          ok = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          if (attempt < opts.maxAttempts - 1) {
            await sleep(opts.backoffBaseMs * 2 ** attempt);
          }
        }
      }
      if (!ok) {
        fatal = `part ${partNumber} via ${ifaceIp ?? 'default'}: ${lastError}`;
        queue.unshift(partNumber);
        return;
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (const ip of ifaces) {
    for (let k = 0; k < opts.perIface; k++) workers.push(worker(ip));
  }
  await Promise.all(workers);
  if (fatal) throw new Error(fatal);

  await api.complete(item.uploadId);
}

export async function uploadAll(
  api: CliApi,
  putter: PartPutter,
  files: LocalFile[],
  target: { projectId: string; folderId: string | null },
  ifaces: (string | null)[],
  opts: UploaderOptions,
): Promise<UploadSummary> {
  const { plan, skipped } = await planUploads(api, files, target);
  const summary: UploadSummary = { uploaded: [], adopted: [], skipped, failed: [] };

  const bytesTotal = plan.reduce((s, p) => s + p.file.size, 0);
  let bytesDone = 0;
  const byIface = new Map<string, number>();

  for (let i = 0; i < plan.length; i++) {
    const item = plan[i]!;
    const report = (bytes: number, iface: string | null) => {
      bytesDone += bytes;
      if (iface !== null) byIface.set(iface, (byIface.get(iface) ?? 0) + bytes);
      opts.onProgress?.({
        file: item.file.name,
        fileIndex: i + 1,
        fileCount: plan.length,
        bytesDone,
        bytesTotal,
        byIface,
      });
    };
    try {
      await uploadOne(api, putter, item, ifaces, opts, report);
      (item.adopted ? summary.adopted : summary.uploaded).push(item.file.name);
    } catch (err) {
      summary.failed.push({ name: item.file.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return summary;
}
