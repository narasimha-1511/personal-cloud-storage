/**
 * Keeps the screen awake while transfers run, so the phone doesn't doze off
 * and let the OS suspend the browser mid-upload. Best-effort: unsupported
 * browsers simply skip it.
 */

let sentinel: WakeLockSentinel | null = null;
let wantActive = false;
let listenerArmed = false;

async function acquire(): Promise<void> {
  if (sentinel || !('wakeLock' in navigator)) return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    // Denied (low battery, unsupported) — nothing to do.
  }
}

export function syncWakeLock(active: boolean): void {
  wantActive = active;
  if (!listenerArmed && typeof document !== 'undefined') {
    listenerArmed = true;
    // The lock is auto-released when the tab is hidden; re-acquire on return.
    document.addEventListener('visibilitychange', () => {
      if (wantActive && document.visibilityState === 'visible') void acquire();
    });
  }
  if (active) {
    void acquire();
  } else if (sentinel) {
    void sentinel.release().catch(() => {});
    sentinel = null;
  }
}

export function wakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}
