import { Hono } from 'hono';
import type { Env } from './env.js';
import type { Db } from './db/index.js';
import { requireAdmin, requireAuth, type AuthVariables } from './auth/middleware.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { uploadRoutes } from './routes/uploads.js';
import { folderRoutes, projectRoutes } from './routes/projects.js';
import { videoRoutes } from './routes/videos.js';
import type { R2Client } from './r2.js';
import { log } from './log.js';

export interface AppDeps {
  env: Env;
  db: Db;
  r2: R2Client | null;
}

export type AppContext = { Variables: AuthVariables };

export function createApp(deps: AppDeps): Hono<AppContext> {
  const { env, db, r2 } = deps;
  const sessionSecret = env.SESSION_SECRET ?? 'dev-insecure-session-secret';
  const auth = requireAuth(db, sessionSecret);

  const app = new Hono<AppContext>();

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.route('/api/auth', authRoutes(db, env, sessionSecret));
  app.use('/api/users/*', auth, requireAdmin);
  app.route('/api/users', userRoutes(db));
  app.use('/api/uploads/*', auth);
  app.route('/api/uploads', uploadRoutes({ db, env, r2 }));
  app.use('/api/projects/*', auth);
  app.use('/api/projects', auth);
  app.route('/api/projects', projectRoutes({ db, r2 }));
  app.use('/api/folders/*', auth);
  app.route('/api/folders', folderRoutes({ db, r2 }));
  app.use('/api/videos/*', auth);
  app.use('/api/videos', auth);
  app.route('/api/videos', videoRoutes({ db, env, r2 }));

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Not found' }, 404);
    }
    return c.text('Not found', 404);
  });

  app.onError((err, c) => {
    log({ op: 'unhandled', ok: false, errorCategory: 'internal', detail: err.message, path: c.req.path });
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
