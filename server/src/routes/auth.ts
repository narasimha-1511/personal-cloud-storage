import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { LoginResponse, UserInfo } from '@videovault/shared';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { verifyPassword } from '../auth/password.js';
import { SESSION_COOKIE, createSession, deleteSession } from '../auth/sessions.js';
import { requireAuth, type AuthVariables } from '../auth/middleware.js';
import { RateLimiter } from '../auth/ratelimit.js';
import type { Env } from '../env.js';
import { log } from '../log.js';

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export function authRoutes(db: Db, env: Env, sessionSecret: string) {
  const app = new Hono<{ Variables: AuthVariables }>();
  // 10 attempts per 5 minutes per ip+username.
  const limiter = new RateLimiter(10, 5 * 60 * 1000);

  app.post('/login', async (c) => {
    const body = loginSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid request' }, 400);
    const { username, password } = body.data;

    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
    if (!limiter.hit(`${ip}:${username.toLowerCase()}`)) {
      log({ op: 'auth.login', ok: false, errorCategory: 'auth', detail: 'rate_limited' });
      return c.json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
    }

    const row = (
      await db.select().from(users).where(eq(users.username, username)).limit(1)
    )[0];
    // Always verify against something so response timing does not reveal
    // whether the username exists.
    const okPassword = await verifyPassword(
      row?.passwordHash ?? '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      password,
    );
    if (!row || !row.active || !okPassword) {
      log({ op: 'auth.login', ok: false, errorCategory: 'auth', detail: 'invalid_credentials' });
      return c.json({ error: 'Invalid username or password' }, 401);
    }

    const { token, expiresAt } = await createSession(db, sessionSecret, row.id, env.SESSION_TTL_DAYS);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'Lax',
      path: '/',
      expires: expiresAt,
    });
    log({ op: 'auth.login', ok: true, userId: row.id });
    const user: UserInfo = {
      id: row.id,
      username: row.username,
      role: row.role,
      createdAt: row.createdAt,
    };
    return c.json({ user } satisfies LoginResponse);
  });

  app.post('/logout', requireAuth(db, sessionSecret), async (c) => {
    await deleteSession(db, sessionSecret, c.get('sessionToken'));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/me', requireAuth(db, sessionSecret), (c) => {
    const user = c.get('user');
    return c.json({ user });
  });

  return app;
}
