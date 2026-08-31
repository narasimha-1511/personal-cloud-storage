import { TransferError, classifyHttpStatus } from './network';

export interface PutPartOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (loadedBytes: number) => void;
}

/**
 * The seam between the upload engine and the real network, so tests can
 * simulate failures deterministically.
 */
export interface PartTransport {
  /** PUT one part to a presigned URL. Resolves with the part's ETag. */
  putPart(url: string, body: Blob, opts: PutPartOptions): Promise<{ etag: string }>;
}

/**
 * XMLHttpRequest rather than fetch: upload progress events (for speed/ETA)
 * and a real timeout are load-bearing here.
 */
export class XhrPartTransport implements PartTransport {
  putPart(url: string, body: Blob, opts: PutPartOptions): Promise<{ etag: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.timeout = opts.timeoutMs;

      const onAbort = () => xhr.abort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => opts.signal?.removeEventListener('abort', onAbort);

      xhr.upload.onprogress = (e) => {
        if (opts.onProgress) opts.onProgress(e.loaded);
      };
      xhr.onload = () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) {
          const etag = xhr.getResponseHeader('ETag');
          if (!etag) {
            // Almost always a missing `exposeHeaders: ["ETag"]` in the R2
            // bucket CORS rules — resume cannot work without it.
            reject(
              new TransferError(
                'fatal',
                'R2 did not expose the ETag header. Check the bucket CORS configuration (exposeHeaders must include "ETag").',
                xhr.status,
              ),
            );
            return;
          }
          resolve({ etag });
        } else {
          reject(
            new TransferError(
              classifyHttpStatus(xhr.status),
              `Part upload failed with HTTP ${xhr.status}`,
              xhr.status,
            ),
          );
        }
      };
      xhr.onerror = () => {
        cleanup();
        reject(new TransferError('network', 'Network error during part upload'));
      };
      xhr.ontimeout = () => {
        cleanup();
        reject(new TransferError('network', 'Part upload timed out'));
      };
      xhr.onabort = () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };

      xhr.send(body);
    });
  }
}
