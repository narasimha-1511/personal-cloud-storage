import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { useDownloads, useUploads } from '../lib/managers';
import { Sheet, SheetAction } from './ui';
import { IconChevronLeft, IconLibrary, IconLogo, IconLogout, IconSparkle, IconTransfers, IconUsers } from './icons';
import { WhatsNewSheet } from './WhatsNew';
import { APP_VERSION } from '../changelog';

const ACTIVE_UPLOAD_STATES = ['queued', 'uploading', 'completing', 'waiting_network', 'paused', 'needs_file'];
const ACTIVE_DOWNLOAD_STATES = ['downloading', 'paused', 'waiting_network'];

export default function Layout({ children, title, back }: { children: ReactNode; title?: string; back?: string }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const uploads = useUploads();
  const downloads = useDownloads();
  const activeCount =
    uploads.filter((u) => ACTIVE_UPLOAD_STATES.includes(u.state)).length +
    downloads.filter((d) => ACTIVE_DOWNLOAD_STATES.includes(d.state)).length;

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

      <main className="mx-auto w-full max-w-lg flex-1 px-4 pb-28 pt-4">{children}</main>

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
