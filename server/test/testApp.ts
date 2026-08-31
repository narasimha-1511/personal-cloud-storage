import type { Hono } from 'hono';
import { createApp, type AppContext } from '../src/app.js';
import { createDb, type Db } from '../src/db/index.js';
import { hashPassword } from '../src/auth/password.js';
import { projects, users } from '../src/db/schema.js';
import { ulid } from 'ulid';
import { testEnv } from './helpers.js';
import { FakeR2Client } from './fakeR2.js';
import type { Env } from '../src/env.js';

export interface TestApp {
  app: Hono<AppContext>;
  db: Db;
  env: Env;
  r2: FakeR2Client;
  /** Creates the user if needed and returns a Cookie header value. */
  loginAs(username: string, role?: 'admin' | 'user'): Promise<string>;
  /** Inserts a project row directly and returns its id. */
  seedProject(slug?: string): Promise<string>;
}

export async function createTestApp(envOverrides: Partial<Env> = {}): Promise<TestApp> {
  const env = testEnv(envOverrides);
  const { db } = createDb(':memory:');
  const r2 = new FakeR2Client();
  const app = createApp({ env, db, r2 });

  const password = 'test-password-123';
  const created = new Set<string>();

  async function loginAs(username: string, role: 'admin' | 'user' = 'user'): Promise<string> {
    if (!created.has(username)) {
      await db.insert(users).values({
        id: ulid(),
        username,
        passwordHash: await hashPassword(password),
        role,
        active: true,
        createdAt: new Date().toISOString(),
      });
      created.add(username);
    }
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) throw new Error('no session cookie');
    return setCookie.split(';')[0]!;
  }

  async function seedProject(slug = 'himachal-2026'): Promise<string> {
    const id = ulid();
    await db.insert(projects).values({
      id,
      slug,
      name: slug,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  return { app, db, env, r2, loginAs, seedProject };
}

/** JSON POST helper for tests. */
export function post(body?: unknown, cookie?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}
