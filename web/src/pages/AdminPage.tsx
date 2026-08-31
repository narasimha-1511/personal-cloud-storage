import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Role, UserInfo } from '@videovault/shared';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useAuth } from '../auth';
import Layout from '../components/Layout';
import { Button, Card, Field, InputSheet, Notice, Sheet, SheetAction, Spinner, inputClass } from '../components/ui';

type UserRow = UserInfo & { active: boolean };

export default function AdminPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [menuFor, setMenuFor] = useState<UserRow | null>(null);
  const [resetting, setResetting] = useState<UserRow | null>(null);

  const load = useCallback(() => {
    api
      .listUsers()
      .then((r) => setUsers(r.users))
      .catch((e) => setNotice(e instanceof Error ? e.message : 'Failed to load users'));
  }, []);
  useEffect(load, [load]);

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    try {
      await api.createUser({ username, password, role });
      setUsername('');
      setPassword('');
      setRole('user');
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not create user');
    }
  }

  return (
    <Layout title="Manage users" back="/">
      <div className="space-y-5">
        {notice && <Notice text={notice} onDismiss={() => setNotice(null)} />}

        <Card>
          <form onSubmit={createUser} className="space-y-4">
            <h2 className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Invite someone</h2>
            <Field label="Username">
              <input className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" required minLength={2} />
            </Field>
            <Field label="Password">
              <input className={inputClass} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            </Field>
            <Field label="Role">
              <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="user">Member — upload, download, manage own videos</option>
                <option value="admin">Admin — everything, including users</option>
              </select>
            </Field>
            <Button type="submit" kind="primary" full>
              Create account
            </Button>
          </form>
        </Card>

        <section>
          <h2 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-slate-500">Accounts</h2>
          {users === null && <Spinner />}
          <div className="space-y-2">
            {users?.map((u) => (
              <div key={u.id} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.04] p-3.5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/8 text-sm font-bold text-sky-300">
                  {u.username.slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {u.username}
                    {u.id === me?.id && <span className="ml-1.5 text-xs font-normal text-slate-500">(you)</span>}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {u.role === 'admin' ? 'Admin' : 'Member'} · since {formatDate(u.createdAt)}
                    {!u.active && <span className="ml-1.5 font-semibold text-red-400">deactivated</span>}
                  </p>
                </div>
                <button
                  onClick={() => setMenuFor(u)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg text-slate-500 hover:bg-white/10 hover:text-slate-200"
                  aria-label={`Options for ${u.username}`}
                >
                  ⋯
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>

      <Sheet open={menuFor !== null} onClose={() => setMenuFor(null)} title={menuFor?.username}>
        <div className="space-y-1">
          <SheetAction
            icon="🔑"
            label="Reset password"
            onClick={() => {
              setResetting(menuFor);
              setMenuFor(null);
            }}
          />
          {menuFor?.id !== me?.id && (
            <SheetAction
              icon={menuFor?.active ? '🚫' : '✅'}
              label={menuFor?.active ? 'Deactivate account' : 'Reactivate account'}
              sub={menuFor?.active ? 'Signs them out everywhere immediately' : undefined}
              danger={menuFor?.active}
              onClick={async () => {
                const u = menuFor!;
                setMenuFor(null);
                try {
                  await api.setUserActive(u.id, !u.active);
                  load();
                } catch (err) {
                  setNotice(err instanceof Error ? err.message : 'Operation failed');
                }
              }}
            />
          )}
        </div>
      </Sheet>

      <InputSheet
        open={resetting !== null}
        onClose={() => setResetting(null)}
        title={`New password for ${resetting?.username}`}
        placeholder="At least 8 characters"
        submitLabel="Set password"
        onSubmit={async (pw) => {
          await api.resetPassword(resetting!.id, pw);
        }}
      />
    </Layout>
  );
}
