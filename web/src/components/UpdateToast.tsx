import { useRegisterSW } from 'virtual:pwa-register/react';
import { setSwRegistration } from '../lib/swUpdate';

/**
 * Shows a reload button when a new deploy is available. Checks on every
 * launch and every 15 minutes while open. Applying the update reloads the
 * page, so it is offered, never forced — an active upload keeps running
 * until the user decides.
 */
export default function UpdateToast() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (registration) {
        setSwRegistration(registration);
        setInterval(() => void registration.update(), 15 * 60 * 1000);
      }
    },
  });

  if (!needRefresh) return null;
  return (
    <div className="fixed inset-x-0 top-[calc(3.5rem+env(safe-area-inset-top))] z-40 flex justify-center px-4">
      <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-[#18181b] py-2 pl-4 pr-2">
        <span className="text-[13px] text-zinc-300">New version available</span>
        <button
          onClick={() => void updateServiceWorker(true)}
          className="h-8 rounded-md bg-blue-600 px-3 text-[12px] font-semibold text-white transition-colors hover:bg-blue-500"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
