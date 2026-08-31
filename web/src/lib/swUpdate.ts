/**
 * On-demand service-worker update check. The registration is captured by
 * UpdateToast when the SW registers; checkForUpdates() asks the server for a
 * new build right now. When one is found it installs in the background and
 * the "New version available — Reload" toast appears.
 */

let registration: ServiceWorkerRegistration | null = null;

export function setSwRegistration(r: ServiceWorkerRegistration): void {
  registration = r;
}

export type UpdateCheckResult = 'found' | 'none' | 'unsupported';

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!registration) return 'unsupported'; // dev mode / SW not ready yet
  if (registration.waiting) return 'found'; // already downloaded, ready to apply
  try {
    await registration.update();
  } catch {
    return 'none'; // offline — nothing we can do
  }
  // Installation kicks off asynchronously; give it a moment to show up.
  for (let i = 0; i < 16; i++) {
    if (registration.installing || registration.waiting) return 'found';
    await new Promise((r) => setTimeout(r, 250));
  }
  return 'none';
}
