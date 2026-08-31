import { loadEnv, type Env } from '../src/env.js';

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...loadEnv({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      SESSION_SECRET: 'test-session-secret-0123456789',
    } as NodeJS.ProcessEnv),
    ...overrides,
  };
}
