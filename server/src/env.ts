import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_PATH: z.string().default('./data/videovault.db'),
  PUBLIC_ORIGIN: z.string().url().optional(),

  // R2 (S3-compatible). Required to actually transfer bytes; the server boots
  // without them in dev so the UI and auth can be worked on offline.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  /** Override the S3 endpoint (e.g. MinIO in local dev). Defaults to the R2 endpoint. */
  S3_ENDPOINT: z.string().url().optional(),

  // First-boot admin seed (used only when the users table is empty).
  ADMIN_USERNAME: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),

  SESSION_SECRET: z.string().min(16).optional(),

  PART_SIZE_BYTES: z.coerce
    .number()
    .int()
    .min(5 * 1024 * 1024, 'S3 multipart parts must be at least 5 MiB')
    .default(50 * 1024 * 1024),
  // Grid thumbnails: small WebP derivatives generated on first view. Keep
  // concurrency low — each job decodes a full-resolution photo in memory.
  THUMBNAILS_ENABLED: z
    .union([z.boolean(), z.string()])
    .default(true)
    .transform((v) => (typeof v === 'boolean' ? v : v !== 'false' && v !== '0')),
  THUMB_MAX_EDGE: z.coerce.number().int().min(64).max(2048).default(512),
  THUMB_QUALITY: z.coerce.number().int().min(1).max(100).default(72),
  // The viewer's display copy. A 40 MP original is ~4.5 MB to fetch and ~160 MB
  // to decode; 2048px is sharp on any screen at a fraction of the cost.
  PREVIEW_MAX_EDGE: z.coerce.number().int().min(512).max(6000).default(2048),
  PREVIEW_QUALITY: z.coerce.number().int().min(1).max(100).default(82),
  THUMB_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  THUMB_MAX_SOURCE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(40 * 1024 * 1024),

  VIEW_URL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  PART_URL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    const required: (keyof Env)[] = [
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
      'SESSION_SECRET',
    ];
    const missing = required.filter((k) => !env[k]);
    if (missing.length > 0) {
      throw new Error(`Missing required production environment variables: ${missing.join(', ')}`);
    }
  }
  return env;
}
