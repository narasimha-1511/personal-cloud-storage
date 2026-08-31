import { describe, expect, it } from 'vitest';
import { createTestApp } from './testApp.js';

describe('auth', () => {
  it('rejects unauthenticated api requests', async () => {
    const { app } = await createTestApp();
    const res = await app.request('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('logs in with valid credentials and sets an httponly cookie', async () => {
    const { app, loginAs } = await createTestApp();
    const cookie = await loginAs('narasimha', 'admin');
    expect(cookie).toMatch(/^vv_session=/);

    const me = await app.request('/api/auth/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { username: string; role: string } };
    expect(body.user.username).toBe('narasimha');
    expect(body.user.role).toBe('admin');
  });

  it('rejects wrong password', async () => {
    const { app, loginAs } = await createTestApp();
    await loginAs('someone');
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'someone', password: 'wrong-password' }),
    });
    expect(res.status).toBe(401);
  });

  it('rate limits repeated failed logins', async () => {
    const { app } = await createTestApp();
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'ghost', password: 'nope-nope-nope' }),
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it('logout invalidates the session', async () => {
    const { app, loginAs } = await createTestApp();
    const cookie = await loginAs('narasimha', 'admin');
    const out = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(200);
    const me = await app.request('/api/auth/me', { headers: { cookie } });
    expect(me.status).toBe(401);
  });
});

describe('user management', () => {
  it('forbids non-admins', async () => {
    const { app, loginAs } = await createTestApp();
    const cookie = await loginAs('pleb', 'user');
    const res = await app.request('/api/users', { headers: { cookie } });
    expect(res.status).toBe(403);
  });

  it('admin can create a user who can then log in', async () => {
    const { app, loginAs } = await createTestApp();
    const cookie = await loginAs('narasimha', 'admin');
    const create = await app.request('/api/users', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'editor', password: 'editor-pass-1', role: 'user' }),
    });
    expect(create.status).toBe(201);

    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'editor', password: 'editor-pass-1' }),
    });
    expect(login.status).toBe(200);
  });

  it('deactivated users cannot log in and lose existing sessions', async () => {
    const { app, loginAs } = await createTestApp();
    const admin = await loginAs('narasimha', 'admin');
    const editorCookie = await loginAs('editor', 'user');

    const list = await app.request('/api/users', { headers: { cookie: admin } });
    const { users } = (await list.json()) as { users: { id: string; username: string }[] };
    const editor = users.find((u) => u.username === 'editor')!;

    const res = await app.request(`/api/users/${editor.id}/set-active`, {
      method: 'POST',
      headers: { cookie: admin, 'content-type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    expect(res.status).toBe(200);

    const me = await app.request('/api/auth/me', { headers: { cookie: editorCookie } });
    expect(me.status).toBe(401);
  });

  it('admin cannot deactivate themselves', async () => {
    const { app, loginAs } = await createTestApp();
    const admin = await loginAs('narasimha', 'admin');
    const me = await app.request('/api/auth/me', { headers: { cookie: admin } });
    const { user } = (await me.json()) as { user: { id: string } };
    const res = await app.request(`/api/users/${user.id}/set-active`, {
      method: 'POST',
      headers: { cookie: admin, 'content-type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    expect(res.status).toBe(400);
  });
});
