import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { Button, Field, inputClass } from '../components/ui';
import { IconLogo } from '../components/icons';

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0c] p-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-5">
        <div className="mb-8 text-center">
          <span className="mx-auto mb-4 flex w-fit items-center justify-center text-zinc-100">
            <IconLogo size={44} />
          </span>
          <h1 className="text-xl font-bold tracking-tight text-zinc-100">Video Vault</h1>
          <p className="mt-1 text-sm text-zinc-500">Original footage, safely transferred</p>
        </div>
        <Field label="Username">
          <input
            className={inputClass}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            required
          />
        </Field>
        <Field label="Password">
          <input
            className={inputClass}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button type="submit" kind="primary" full size="lg" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </main>
  );
}
