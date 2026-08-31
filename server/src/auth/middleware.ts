import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Db } from '../db/index.js';
import { SESSION_COOKIE, getSessionUser, type SessionUser } from './sessions.js';

export type AuthVariables = {
  user: SessionUser;
  sessionToken: string;
};

export function requireAuth(db: Db, secret: string): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const user = await getSessionUser(db, secret, token);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    c.set('sessionToken', token);
    await next();
  };
}

export const requireAdmin: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  if (c.get('user')?.role !== 'admin') {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
};
