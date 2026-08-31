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
  root.use('/*', serveStatic({ root: staticDir }));
  // SPA fallback: any non-API, non-file route serves index.html.
  root.get('/*', serveStatic({ root: staticDir, path: 'index.html' }));
}

serve({ fetch: root.fetch, port: env.PORT }, (info) => {
  log({ op: 'server.start', ok: true, port: info.port, staticDir: staticDir ?? null });
});
