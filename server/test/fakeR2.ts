import type { R2Client, UploadedPart } from '../src/r2.js';

interface FakeMultipart {
  key: string;
  contentType: string;
  parts: Map<number, UploadedPart>;
  aborted: boolean;
}

/**
 * In-memory stand-in for R2. Tests "upload a part" by calling putPart the
 * way the browser would PUT to a presigned URL.
 */
export class FakeR2Client implements R2Client {
  multiparts = new Map<string, FakeMultipart>();
  objects = new Map<string, { size: number; contentType: string }>();
  private counter = 0;

  async createMultipartUpload(key: string, contentType: string) {
    const uploadId = `fake-upload-${++this.counter}`;
    this.multiparts.set(uploadId, { key, contentType, parts: new Map(), aborted: false });
    return { uploadId };
  }

  async signPartUrl(key: string, uploadId: string, partNumber: number, _ttl: number) {
    return `https://fake-r2.local/${encodeURIComponent(key)}?uploadId=${uploadId}&partNumber=${partNumber}`;
  }

  /** Simulates the browser's direct PUT to R2. Returns the part's ETag. */
  putPart(uploadId: string, partNumber: number, size: number): string {
    const mp = this.get(uploadId);
    const etag = `"etag-${partNumber}-${size}"`;
    mp.parts.set(partNumber, { partNumber, etag, size });
    return etag;
  }

  async listParts(_key: string, uploadId: string) {
    const mp = this.get(uploadId);
    return [...mp.parts.values()].sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]) {
    const mp = this.get(uploadId);
    let total = 0;
    for (const p of parts) {
      const stored = mp.parts.get(p.partNumber);
      if (!stored || stored.etag !== p.etag) {
        throw new Error(`InvalidPart: part ${p.partNumber}`);
      }
      total += stored.size;
    }
    this.objects.set(key, { size: total, contentType: mp.contentType });
    this.multiparts.delete(uploadId);
  }

  async abortMultipartUpload(_key: string, uploadId: string) {
    this.multiparts.delete(uploadId);
  }

  async signGetUrl(key: string, _ttl: number, opts: { disposition: string }) {
    return `https://fake-r2.local/${encodeURIComponent(key)}?disposition=${opts.disposition}&sig=fake`;
  }

  async headObject(key: string) {
    const obj = this.objects.get(key);
    return obj ? { size: obj.size } : null;
  }

  async deleteObject(key: string) {
    this.objects.delete(key);
  }

  private get(uploadId: string): FakeMultipart {
    const mp = this.multiparts.get(uploadId);
    if (!mp) throw new Error('NoSuchUpload');
    return mp;
  }
}
