import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from './env.js';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

/**
 * Everything the app needs from object storage, behind an interface so tests
 * can inject an in-memory fake. The real implementation talks to Cloudflare
 * R2 over the S3 API and presigns URLs the browser uses directly — video
 * bytes never pass through this server.
 */
export interface R2Client {
  createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }>;
  signPartUrl(key: string, uploadId: string, partNumber: number, ttlSeconds: number): Promise<string>;
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  signGetUrl(
    key: string,
    ttlSeconds: number,
    opts: { filename: string; disposition: 'inline' | 'attachment' },
  ): Promise<string>;
  headObject(key: string): Promise<{ size: number } | null>;
  deleteObject(key: string): Promise<void>;
}

export function createR2Client(env: Env): R2Client | null {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET) return null;
  if (!env.S3_ENDPOINT && !env.R2_ACCOUNT_ID) return null;

  const bucket = env.R2_BUCKET;
  const s3 = new S3Client({
    region: 'auto',
    endpoint: env.S3_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    // MinIO in local dev needs path-style addressing.
    forcePathStyle: Boolean(env.S3_ENDPOINT),
  });

  return {
    async createMultipartUpload(key, contentType) {
      const out = await s3.send(
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
      );
      if (!out.UploadId) throw new Error('R2 returned no UploadId');
      return { uploadId: out.UploadId };
    },

    async signPartUrl(key, uploadId, partNumber, ttlSeconds) {
      return getSignedUrl(
        s3,
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: ttlSeconds },
      );
    },

    async listParts(key, uploadId) {
      const parts: UploadedPart[] = [];
      let marker: string | undefined;
      // Paginated: R2 returns at most 1000 parts per call and a 50 MB part
      // size means >1000 parts past ~50 GB files.
      do {
        const out = await s3.send(
          new ListPartsCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const p of out.Parts ?? []) {
          if (p.PartNumber && p.ETag && p.Size !== undefined) {
            parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size });
          }
        }
        marker = out.IsTruncated ? out.NextPartNumberMarker : undefined;
      } while (marker);
      return parts;
    },

    async completeMultipartUpload(key, uploadId, parts) {
      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      );
    },

    async abortMultipartUpload(key, uploadId) {
      await s3.send(
        new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
      );
    },

    async signGetUrl(key, ttlSeconds, opts) {
      // RFC 5987 encoding so filenames with spaces/unicode survive.
      const encoded = encodeURIComponent(opts.filename).replace(/'/g, '%27');
      return getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: `${opts.disposition}; filename*=UTF-8''${encoded}`,
        }),
        { expiresIn: ttlSeconds },
      );
    },

    async headObject(key) {
      try {
        const out = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: out.ContentLength ?? 0 };
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.name === '404')
        ) {
          return null;
        }
        throw err;
      }
    },

    async deleteObject(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
