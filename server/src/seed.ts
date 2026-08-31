import { ulid } from 'ulid';
import { users } from './db/schema.js';
import type { Db } from './db/index.js';
import type { Env } from './env.js';
import { hashPassword } from './auth/password.js';
import { log } from './log.js';

/** Creates the initial admin from env on first boot (only when no users exist). */
export async function seedAdmin(db: Db, env: Env): Promise<void> {
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length > 0) return;
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    log({
      op: 'seed.admin',
      ok: false,
      errorCategory: 'validation',
      detail: 'No users exist and ADMIN_USERNAME/ADMIN_PASSWORD are not set; nobody can log in.',
    });
    return;
  }
  await db.insert(users).values({
    id: ulid(),
    username: env.ADMIN_USERNAME,
    passwordHash: await hashPassword(env.ADMIN_PASSWORD),
    role: 'admin',
    active: true,
    createdAt: new Date().toISOString(),
  });
  log({ op: 'seed.admin', ok: true });
}
