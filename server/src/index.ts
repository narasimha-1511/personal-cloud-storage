import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import { createApp } from './app.js';
import { createDb } from './db/index.js';
import { loadEnv } from './env.js';
import { log } from './log.js';
import { seedAdmin } from './seed.js';
import { pruneSessions } from './auth/sessions.js';
import { createR2Client } from './r2.js';
import { sweepStaleUploads } from './sweep.js';

const env = loadEnv();
const { db } = createDb(env.DATABASE_PATH);
await seedAdmin(db, env);
await pruneSessions(db);

const r2 = createR2Client(env);
if (!r2) {
  log({
    op: 'server.config',
    ok: false,
    errorCategory: 'validation',
    detail: 'R2 is not configured; uploads and downloads are disabled until R2_* vars are set.',
  });
}

const api = createApp({ env, db, r2 });

// Abort week-old abandoned multipart uploads: on boot and every 6 hours.
void sweepStaleUploads(db, r2);
setInterval(() => void sweepStaleUploads(db, r2), 6 * 60 * 60 * 1000).unref();

const root = new Hono();
root.route('/', api);

// In production the built PWA is served from ./public (copied in Docker);
// in dev, Vite serves the frontend and proxies /api here.
const staticDir = ['./public', '../web/dist'].find((d) => existsSync(d));
if (staticDir) {
  /**
   * Caching rules, which matter because a CDN sits in front of this in
   * production.
   *
   * Build outputs under /assets carry a content hash in their filename, so they
   * are safe to cache forever. index.html is the opposite: it names the current
   * hashed bundle, so an edge that holds it for hours will keep handing out a
   * document pointing at a bundle the next deploy has already deleted.
   */
  root.use('/assets/*', async (c, next) => {
    await next();
    if (c.res.ok) c.res.headers.set('cache-control', 'public, max-age=31536000, immutable');
  });
  root.use('/*', async (c, next) => {
    await next();
    if (c.res.ok && c.res.headers.get('content-type')?.includes('text/html')) {
      c.res.headers.set('cache-control', 'no-cache');
    }
  });

  root.use('/*', serveStatic({ root: staticDir }));

  /**
   * SPA fallback: client-side routes such as /p/:id must return the app shell.
   *
   * Requests that look like a file must NOT. Answering a missing
   * /assets/index-OLD.js with index.html returns HTML, at status 200, under a
   * .js URL — which a CDN caches for hours and browsers then try to execute as
   * JavaScript, leaving a white screen until it expires. A real 404 lets the
   * browser fail loudly and the edge cache stay clean.
   */
  root.get('/*', async (c, next) => {
    if (/\.[a-z0-9]+$/i.test(c.req.path)) return c.text('Not found', 404);
    return next();
  });
  root.get('/*', serveStatic({ root: staticDir, path: 'index.html' }));
}

serve({ fetch: root.fetch, port: env.PORT }, (info) => {
  log({ op: 'server.start', ok: true, port: info.port, staticDir: staticDir ?? null });
});
