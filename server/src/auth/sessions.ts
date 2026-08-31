import { createHmac, randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions, users } from '../db/schema.js';

export const SESSION_COOKIE = 'vv_session';

function hashToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

export interface SessionUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

export async function createSession(
  db: Db,
  secret: string,
  userId: string,
  ttlDays: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({
    tokenHash: hashToken(secret, token),
    userId,
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
  });
  return { token, expiresAt };
}

export async function getSessionUser(
  db: Db,
  secret: string,
  token: string,
): Promise<SessionUser | null> {
  const nowIso = new Date().toISOString();
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      active: users.active,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, hashToken(secret, token)), gt(sessions.expiresAt, nowIso)))
    .limit(1);
  const row = rows[0];
  if (!row || !row.active) return null;
  return { id: row.id, username: row.username, role: row.role };
}

export async function deleteSession(db: Db, secret: string, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(secret, token)));
}

/** Removes expired sessions; called opportunistically on boot. */
export async function pruneSessions(db: Db): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString()));
}
