/**
 * Failure classification. navigator.onLine is only a hint — the truth about
 * the network is whether HTTP requests actually succeed.
 */

export type FailureKind =
  | 'network' // fetch/XHR failed at the transport level, or timed out
  | 'expired_url' // presigned URL no longer valid; re-sign and retry
  | 'transient' // 5xx / 429: server hiccup, retry with backoff
  | 'fatal'; // anything else: retrying will not help

export class TransferError extends Error {
  constructor(
    public readonly kind: FailureKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'TransferError';
  }
}

export function classifyHttpStatus(status: number): FailureKind {
  if (status === 403) return 'expired_url';
  if (status === 429 || status >= 500) return 'transient';
  return 'fatal';
}

export function isRetryable(kind: FailureKind): boolean {
  return kind !== 'fatal';
}

/** Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s (+/- 20%). */
export function backoffMs(attempt: number, baseMs = 1000, maxMs = 16000): number {
  const exp = Math.min(baseMs * 2 ** attempt, maxMs);
  const jitter = exp * 0.2 * (Math.random() * 2 - 1);
  return Math.round(exp + jitter);
}

export function onOnline(listener: () => void): () => void {
  window.addEventListener('online', listener);
  return () => window.removeEventListener('online', listener);
}
