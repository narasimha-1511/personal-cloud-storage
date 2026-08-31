import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Role, UserInfo } from '@videovault/shared';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { Button, Card, Field, inputClass } from '../components/ui';
import { useAuth } from '../auth';

type UserRow = UserInfo & { active: boolean };

export default function AdminPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('user');

  const load = useCallback(() => {
    api.listUsers().then((r) => setUsers(r.users)).catch((e) => setNotice(e instanceof Error ? e.message : 'Failed to load'));
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

  async function act(fn: () => Promise<unknown>) {
    setNotice(null);
    try {
      await fn();
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Operation failed');
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <form onSubmit={createUser} className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Create user</h2>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username">
              <input className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" required minLength={2} />
            </Field>
            <Field label="Password">
              <input className={inputClass} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            </Field>
          </div>
          <Field label="Role">
            <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="user">user — upload, download, manage own videos</option>
              <option value="admin">admin — everything</option>
            </select>
          </Field>
          <Button type="submit" kind="primary">
            Create user
          </Button>
        </form>
      </Card>

      {notice && <p className="rounded-lg border border-amber-800 bg-amber-950 px-3 py-2 text-sm text-amber-200">{notice}</p>}

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Users</h2>
        {users.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2">
            <div>
              <p className="text-sm font-medium">
                {u.username}
                <span className="ml-2 rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-300">{u.role}</span>
                {!u.active && <span className="ml-2 rounded bg-red-900 px-1.5 py-0.5 text-xs text-red-200">deactivated</span>}
              </p>
              <p className="text-xs text-slate-500">since {formatDate(u.createdAt)}</p>
            </div>
            <div className="flex gap-1">
              <Button
                kind="ghost"
                onClick={() => {
                  const pw = prompt(`New password for ${u.username} (min 8 chars):`);
                  if (pw) void act(() => api.resetPassword(u.id, pw));
                }}
              >
                Reset password
              </Button>
              {u.id !== me?.id && (
                <Button kind={u.active ? 'danger' : 'default'} onClick={() => void act(() => api.setUserActive(u.id, !u.active))}>
                  {u.active ? 'Deactivate' : 'Reactivate'}
                </Button>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
