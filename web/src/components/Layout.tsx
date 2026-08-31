import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { useDownloads, useUploads } from '../lib/managers';
import { Sheet, SheetAction } from './ui';

const ACTIVE_UPLOAD_STATES = ['queued', 'uploading', 'completing', 'waiting_network', 'paused', 'needs_file'];
const ACTIVE_DOWNLOAD_STATES = ['downloading', 'paused', 'waiting_network'];

export default function Layout({ children, title, back }: { children: ReactNode; title?: string; back?: string }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const uploads = useUploads();
  const downloads = useDownloads();
  const activeCount =
    uploads.filter((u) => ACTIVE_UPLOAD_STATES.includes(u.state)).length +
    downloads.filter((d) => ACTIVE_DOWNLOAD_STATES.includes(d.state)).length;

  return (
    <div className="flex min-h-dvh flex-col bg-[#070b14] text-slate-100">
      <header className="sticky top-0 z-30 border-b border-white/5 bg-[#070b14]/90 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-lg items-center gap-3 px-4">
          {back !== undefined ? (
            <button
              onClick={() => navigate(back)}
              className="-ml-2 flex h-9 w-9 items-center justify-center rounded-full text-xl text-slate-300 transition-colors hover:bg-white/8"
              aria-label="Back"
            >
              ‹
            </button>
          ) : (
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-cyan-400 text-xs shadow-lg shadow-sky-500/30">
              ▶
            </span>
          )}
          <h1 className="min-w-0 flex-1 truncate text-[17px] font-bold tracking-tight">{title ?? 'Video Vault'}</h1>
          <button
            onClick={() => setMenuOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-sm font-bold text-sky-300"
            aria-label="Account"
          >
            {user?.username.slice(0, 1).toUpperCase()}
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-lg flex-1 px-4 pb-28 pt-4">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-white/5 bg-[#0a0f1c]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-lg items-stretch">
          <Tab to="/" label="Library" icon="🗂" end />
          <Tab to="/transfers" label="Transfers" icon="⇅" badge={activeCount || undefined} />
        </div>
      </nav>

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)}>
        <div className="mb-4 flex items-center gap-3 px-1">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-cyan-400 text-base font-bold text-white">
            {user?.username.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <p className="text-sm font-bold">{user?.username}</p>
            <p className="text-xs text-slate-500">{user?.role === 'admin' ? 'Administrator' : 'Member'}</p>
          </div>
        </div>
        <div className="space-y-1">
          {user?.role === 'admin' && (
            <SheetAction
              icon="👥"
              label="Manage users"
              sub="Create accounts, reset passwords"
              onClick={() => {
                setMenuOpen(false);
                navigate('/admin');
              }}
            />
          )}
          <SheetAction icon="↩" label="Sign out" onClick={() => void logout()} />
        </div>
      </Sheet>
    </div>
  );
}

function Tab({ to, label, icon, badge, end }: { to: string; label: string; icon: string; badge?: number; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `relative flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-semibold transition-colors ${isActive ? 'text-sky-400' : 'text-slate-500 hover:text-slate-300'}`
      }
    >
      <span className="relative text-xl leading-none">
        {icon}
        {badge !== undefined && (
          <span className="absolute -right-3 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-bold text-white">
            {badge}
          </span>
        )}
      </span>
      {label}
    </NavLink>
  );
}
