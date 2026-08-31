import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { uploadManager, useDownloads, useUploads } from '../lib/managers';
import { syncWakeLock } from '../lib/wakeLock';
import { checkForUpdates } from '../lib/swUpdate';
import { Sheet, SheetAction } from './ui';
import { IconChevronLeft, IconDownload, IconLibrary, IconLogo, IconLogout, IconSparkle, IconTransfers, IconUsers } from './icons';
import { WhatsNewSheet } from './WhatsNew';
import { APP_VERSION } from '../changelog';

const ACTIVE_UPLOAD_STATES = ['queued', 'uploading', 'completing', 'waiting_network', 'paused', 'needs_file'];
const ACTIVE_DOWNLOAD_STATES = ['downloading', 'paused', 'waiting_network'];

export default function Layout({ children, title, back }: { children: ReactNode; title?: string; back?: string }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'none' | 'unsupported'>('idle');
  const uploads = useUploads();
  const downloads = useDownloads();
  const activeCount =
    uploads.filter((u) => ACTIVE_UPLOAD_STATES.includes(u.state)).length +
    downloads.filter((d) => ACTIVE_DOWNLOAD_STATES.includes(d.state)).length;

  // ---- transfer protections ----
  const transferring =
    uploads.some((u) => u.state === 'uploading' || u.state === 'completing' || u.state === 'queued') ||
    downloads.some((d) => d.state === 'downloading');

  // Keep the screen awake while bytes are moving.
  useEffect(() => {
    syncWakeLock(transferring);
    return () => syncWakeLock(false);
  }, [transferring]);

  // Warn before an accidental reload/close while transfers are running.
  useEffect(() => {
    if (!transferring) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [transferring]);

  // ---- bulk file re-attach after a reload ----
  const needsFile = uploads.filter((u) => u.state === 'needs_file');
  const resumeInput = useRef<HTMLInputElement>(null);
  const [resumeMsg, setResumeMsg] = useState<string | null>(null);

  async function onResumeAllPick(files: FileList) {
    const pending = [...needsFile];
    const used = new Set<string>();
    let ok = 0;
    let miss = 0;
    for (const file of Array.from(files)) {
      const target = pending.find(
        (u) =>
          !used.has(u.localId) &&
          u.filename === file.name &&
          u.size === file.size,
      );
      if (!target) {
        miss++;
        continue;
      }
      try {
        await uploadManager.provideFile(target.localId, file);
        used.add(target.localId);
        ok++;
      } catch {
        miss++;
      }
    }
    setResumeMsg(
      ok > 0
        ? `${ok} upload${ok === 1 ? '' : 's'} resumed${miss > 0 ? ` — ${miss} file${miss === 1 ? '' : 's'} didn't match` : ''}`
        : 'None of the picked files matched — select the exact original files.',
    );
    setTimeout(() => setResumeMsg(null), 5000);
  }

  return (
    <div className="flex min-h-dvh flex-col bg-[#0a0a0c] text-zinc-100">
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#0a0a0c]/95 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex h-[52px] max-w-lg items-center gap-2.5 px-4">
          {back !== undefined ? (
            <button
              onClick={() => navigate(back)}
              className="-ml-2.5 flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
              aria-label="Back"
            >
              <IconChevronLeft size={20} />
            </button>
          ) : (
            <span className="text-zinc-100">
              <IconLogo size={22} />
            </span>
          )}
          <h1 className="min-w-0 flex-1 truncate text-[16px] font-semibold tracking-tight">{title ?? 'Video Vault'}</h1>
          <button
            onClick={() => setMenuOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-[12px] font-semibold text-zinc-300 transition-colors hover:bg-white/10"
            aria-label="Account"
          >
            {user?.username.slice(0, 1).toUpperCase()}
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-lg flex-1 px-4 pb-28 pt-4">
        {needsFile.length > 0 && (
          <div className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-4">
            <p className="text-[13px] font-semibold text-amber-200">
              {needsFile.length} upload{needsFile.length === 1 ? ' is' : 's are'} waiting for {needsFile.length === 1 ? 'its file' : 'their files'}
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-amber-200/70">
              The page was reloaded, so the app needs the files again. Select them all in one go — nothing
              already uploaded is sent twice.
            </p>
            <button
              onClick={() => resumeInput.current?.click()}
              className="mt-3 h-9 rounded-lg bg-amber-500 px-4 text-[13px] font-semibold text-black transition-colors hover:bg-amber-400"
            >
              Re-select {needsFile.length === 1 ? 'the file' : `all ${needsFile.length} files`}
            </button>
            {resumeMsg && <p className="mt-2 text-[12px] text-amber-200">{resumeMsg}</p>}
          </div>
        )}
        <input
          ref={resumeInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void onResumeAllPick(e.target.files);
            e.target.value = '';
          }}
        />
        {children}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-white/[0.06] bg-[#0e0e11]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="mx-auto flex max-w-lg items-stretch">
          <Tab to="/" label="Library" icon={<IconLibrary size={21} />} end />
          <Tab to="/transfers" label="Transfers" icon={<IconTransfers size={21} />} badge={activeCount || undefined} />
        </div>
      </nav>

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)}>
        <div className="mb-4 flex items-center gap-3 px-1">
          <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-[14px] font-semibold text-zinc-200">
            {user?.username.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <p className="text-[14px] font-semibold">{user?.username}</p>
            <p className="text-[12px] text-zinc-500">{user?.role === 'admin' ? 'Administrator' : 'Member'}</p>
          </div>
        </div>
        <div className="space-y-0.5">
          {user?.role === 'admin' && (
            <SheetAction
              icon={<IconUsers size={18} />}
              label="Manage users"
              sub="Create accounts, reset passwords"
              onClick={() => {
                setMenuOpen(false);
                navigate('/admin');
              }}
            />
          )}
          <SheetAction
            icon={<IconSparkle size={18} />}
            label="What's new"
            sub={`Version ${APP_VERSION}`}
            onClick={() => {
              setMenuOpen(false);
              setWhatsNewOpen(true);
            }}
          />
          <SheetAction
            icon={<IconDownload size={18} />}
            label="Check for updates"
            sub={
              updateState === 'checking'
                ? 'Checking…'
                : updateState === 'none'
                  ? "You're on the latest version"
                  : updateState === 'unsupported'
                    ? 'Available in the installed app'
                    : 'Fetch the newest version now'
            }
            onClick={async () => {
              if (updateState === 'checking') return;
              setUpdateState('checking');
              const result = await checkForUpdates();
              if (result === 'found') {
                // The "New version available — Reload" toast takes over.
                setUpdateState('idle');
                setMenuOpen(false);
              } else {
                setUpdateState(result === 'none' ? 'none' : 'unsupported');
                setTimeout(() => setUpdateState('idle'), 4000);
              }
            }}
          />
          <SheetAction icon={<IconLogout size={18} />} label="Sign out" onClick={() => void logout()} />
        </div>
      </Sheet>

      <WhatsNewSheet open={whatsNewOpen} onClose={() => setWhatsNewOpen(false)} />
    </div>
  );
}

function Tab({ to, label, icon, badge, end }: { to: string; label: string; icon: ReactNode; badge?: number; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[10.5px] font-medium transition-colors ${isActive ? 'text-zinc-100' : 'text-zinc-600 hover:text-zinc-400'}`
      }
    >
      <span className="relative">
        {icon}
        {badge !== undefined && (
          <span className="absolute -right-2.5 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-blue-500 px-1 text-[9px] font-bold text-white">
            {badge}
          </span>
        )}
      </span>
      {label}
    </NavLink>
  );
}
