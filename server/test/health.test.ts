import { describe, expect, it } from 'vitest';
import { createTestApp } from './testApp.js';

describe('health', () => {
  it('responds ok', async () => {
    const { app } = await createTestApp();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('404s unknown api routes as json', async () => {
    const { app } = await createTestApp();
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});
