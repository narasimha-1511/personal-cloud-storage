import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Role, UserInfo } from '@videovault/shared';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useAuth } from '../auth';
import Layout from '../components/Layout';
import { Button, Card, Field, InputSheet, Notice, Segmented, Sheet, SheetAction, Spinner, inputClass } from '../components/ui';
import { IconKey, IconMore, IconUserOff, IconUsers } from '../components/icons';

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
            <h2 className="text-[11px] font-bold uppercase tracking-widest text-zinc-500">Invite someone</h2>
            <Field label="Username">
              <input className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" required minLength={2} />
            </Field>
            <Field label="Password">
              <input className={inputClass} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            </Field>
            <Field label="Role">
              <Segmented<Role>
                options={[
                  { value: 'user', label: 'Member' },
                  { value: 'admin', label: 'Admin' },
                ]}
                value={role}
                onChange={setRole}
              />
              <span className="mt-1.5 block text-[12px] text-zinc-600">
                {role === 'admin' ? 'Full access, including user management.' : 'Uploads, downloads, and their own videos.'}
              </span>
            </Field>
            <Button type="submit" kind="primary" full>
              Create account
            </Button>
          </form>
        </Card>

        <section>
          <h2 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-zinc-500">Accounts</h2>
          {users === null && <Spinner />}
          <div className="space-y-2">
            {users?.map((u) => (
              <div key={u.id} className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-[13px] font-semibold text-zinc-300">
                  {u.username.slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {u.username}
                    {u.id === me?.id && <span className="ml-1.5 text-xs font-normal text-zinc-500">(you)</span>}
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    {u.role === 'admin' ? 'Admin' : 'Member'} · since {formatDate(u.createdAt)}
                    {!u.active && <span className="ml-1.5 font-semibold text-red-400">deactivated</span>}
                  </p>
                </div>
                <button
                  onClick={() => setMenuFor(u)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-600 transition-colors hover:bg-white/[0.06] hover:text-zinc-300"
                  aria-label={`Options for ${u.username}`}
                >
                  <IconMore size={18} />
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>

      <Sheet open={menuFor !== null} onClose={() => setMenuFor(null)} title={menuFor?.username}>
        <div className="space-y-1">
          <SheetAction
            icon={<IconKey size={18} />}
            label="Reset password"
            onClick={() => {
              setResetting(menuFor);
              setMenuFor(null);
            }}
          />
          {menuFor?.id !== me?.id && (
            <SheetAction
              icon={menuFor?.active ? <IconUserOff size={18} /> : <IconUsers size={18} />}
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
