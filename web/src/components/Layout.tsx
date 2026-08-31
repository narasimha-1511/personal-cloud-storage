import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth';

const tabs = [
  { to: '/', label: 'Upload' },
  { to: '/browse', label: 'Browse' },
  { to: '/editor', label: 'Editor' },
];

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  return (
    <div className="flex min-h-dvh flex-col bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <span className="text-sm font-bold tracking-widest">VIDEO VAULT</span>
          <div className="flex items-center gap-3 text-sm text-slate-400">
            <span>{user?.username}</span>
            <button onClick={() => void logout()} className="text-slate-500 underline-offset-2 hover:underline">
              Sign out
            </button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-3xl gap-1 px-2 pb-2">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.to === '/'}
              className={({ isActive }) =>
                `rounded-lg px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`
              }
            >
              {t.label}
            </NavLink>
          ))}
          {user?.role === 'admin' && (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                `rounded-lg px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`
              }
            >
              Admin
            </NavLink>
          )}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-4 pb-16">{children}</main>
    </div>
  );
}
