import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { UserInfo } from '@videovault/shared';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import type { AuthVariables } from '../auth/middleware.js';
import { log } from '../log.js';

const createUserSchema = z.object({
  username: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Letters, digits, dot, dash, underscore only'),
  password: z.string().min(8).max(256),
  role: z.enum(['admin', 'user']),
});

const resetPasswordSchema = z.object({ password: z.string().min(8).max(256) });

function toUserInfo(row: typeof users.$inferSelect): UserInfo & { active: boolean } {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.createdAt,
    active: row.active,
  };
}

/** Admin-only user management. Mounted behind requireAuth + requireAdmin. */
export function userRoutes(db: Db) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get('/', async (c) => {
    const rows = await db.select().from(users).orderBy(users.createdAt);
    return c.json({ users: rows.map(toUserInfo) });
  });

  app.post('/', async (c) => {
    const body = createUserSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: body.error.issues[0]?.message ?? 'Invalid request' }, 400);
    }
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, body.data.username));
    if (existing.length > 0) return c.json({ error: 'Username already exists' }, 409);

    const row = {
      id: ulid(),
      username: body.data.username,
      passwordHash: await hashPassword(body.data.password),
      role: body.data.role,
      active: true,
      createdAt: new Date().toISOString(),
    };
    await db.insert(users).values(row);
    log({ op: 'users.create', ok: true, userId: c.get('user').id, createdUserId: row.id });
    return c.json({ user: toUserInfo(row) }, 201);
  });

  app.post('/:id/reset-password', async (c) => {
    const body = resetPasswordSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Password must be at least 8 characters' }, 400);
    const result = await db
      .update(users)
      .set({ passwordHash: await hashPassword(body.data.password) })
      .where(eq(users.id, c.req.param('id')));
    if (result.changes === 0) return c.json({ error: 'User not found' }, 404);
    log({ op: 'users.reset_password', ok: true, userId: c.get('user').id, targetUserId: c.req.param('id') });
    return c.json({ ok: true });
  });

  app.post('/:id/set-active', async (c) => {
    const body = z
      .object({ active: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid request' }, 400);
    const id = c.req.param('id');
    if (id === c.get('user').id) return c.json({ error: 'You cannot deactivate yourself' }, 400);
    const result = await db.update(users).set({ active: body.data.active }).where(eq(users.id, id));
    if (result.changes === 0) return c.json({ error: 'User not found' }, 404);
    log({ op: 'users.set_active', ok: true, userId: c.get('user').id, targetUserId: id, active: body.data.active });
    return c.json({ ok: true });
  });

  return app;
}
