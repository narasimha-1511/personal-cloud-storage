// Structured JSON logs. One line per operation.
// Never log secrets, signed URLs, or request bodies.

export type ErrorCategory =
  | 'auth'
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'r2'
  | 'db'
  | 'internal';

export interface LogFields {
  op: string;
  userId?: string;
  uploadId?: string;
  videoId?: string;
  projectId?: string;
  partNumber?: number;
  durationMs?: number;
  ok: boolean;
  errorCategory?: ErrorCategory;
  detail?: string;
  [key: string]: unknown;
}

export function log(fields: LogFields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...fields });
  if (fields.ok) {
    console.log(line);
  } else {
    console.error(line);
  }
}

/** Wrap an operation: logs op, duration, and success/failure, then rethrows. */
export async function logged<T>(
  op: string,
  fields: Omit<LogFields, 'op' | 'ok' | 'durationMs'>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    log({ op, ...fields, ok: true, durationMs: Math.round(performance.now() - start) });
    return result;
  } catch (err) {
    log({
      op,
      ...fields,
      ok: false,
      durationMs: Math.round(performance.now() - start),
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
