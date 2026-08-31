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
