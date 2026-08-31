import { useEffect, useRef, useState, type ReactNode } from 'react';

/* ---------- buttons ---------- */

export function Button({
  children,
  onClick,
  kind = 'default',
  disabled,
  type = 'button',
  full,
  size = 'md',
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  type?: 'button' | 'submit';
  full?: boolean;
  size?: 'md' | 'lg';
}) {
  const styles = {
    default: 'bg-white/8 hover:bg-white/12 text-slate-100 border border-white/10',
    primary: 'bg-sky-500 hover:bg-sky-400 text-white shadow-lg shadow-sky-500/25',
    danger: 'bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/20',
    ghost: 'bg-transparent hover:bg-white/5 text-slate-300',
  } as const;
  const sizes = { md: 'px-4 py-2.5 text-sm', lg: 'px-5 py-3.5 text-base' } as const;
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-xl font-semibold transition-all active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 ${styles[kind]} ${sizes[size]} ${full ? 'w-full' : ''}`}
    >
      {children}
    </button>
  );
}

/* ---------- status ---------- */

const CHIP: Record<string, { cls: string; label: string; pulse?: boolean }> = {
  queued: { cls: 'bg-white/10 text-slate-300', label: 'Queued' },
  uploading: { cls: 'bg-sky-500/15 text-sky-300', label: 'Uploading', pulse: true },
  downloading: { cls: 'bg-sky-500/15 text-sky-300', label: 'Downloading', pulse: true },
  paused: { cls: 'bg-white/10 text-slate-300', label: 'Paused' },
  waiting_network: { cls: 'bg-amber-500/15 text-amber-300', label: 'Waiting for network', pulse: true },
  needs_file: { cls: 'bg-amber-500/15 text-amber-300', label: 'Tap to resume' },
  completing: { cls: 'bg-indigo-500/15 text-indigo-300', label: 'Finishing…', pulse: true },
  done: { cls: 'bg-emerald-500/15 text-emerald-300', label: 'Done' },
  error: { cls: 'bg-red-500/15 text-red-300', label: 'Failed' },
  aborted: { cls: 'bg-white/5 text-slate-500', label: 'Cancelled' },
  READY: { cls: 'bg-emerald-500/15 text-emerald-300', label: 'Ready' },
  UPLOADING: { cls: 'bg-sky-500/15 text-sky-300', label: 'Uploading', pulse: true },
  FAILED: { cls: 'bg-red-500/15 text-red-300', label: 'Failed' },
  ABORTED: { cls: 'bg-white/5 text-slate-500', label: 'Cancelled' },
};

export function StatusChip({ state }: { state: string }) {
  const c = CHIP[state] ?? { cls: 'bg-white/10 text-slate-300', label: state };
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${c.cls}`}>
      {c.pulse && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {c.label}
    </span>
  );
}

export function ProgressBar({ value, tone = 'sky' }: { value: number; tone?: 'sky' | 'emerald' | 'amber' }) {
  const colors = {
    sky: 'from-sky-500 to-cyan-400',
    emerald: 'from-emerald-500 to-teal-400',
    amber: 'from-amber-500 to-orange-400',
  } as const;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/8">
      <div
        className={`h-full rounded-full bg-gradient-to-r transition-[width] duration-500 ease-out ${colors[tone]}`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

/* ---------- surfaces ---------- */

export function Card({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  const cls = 'rounded-2xl border border-white/8 bg-white/[0.04] p-4';
  if (onClick) {
    return (
      <button onClick={onClick} className={`${cls} block w-full text-left transition-colors hover:bg-white/[0.07] active:scale-[0.99]`}>
        {children}
      </button>
    );
  }
  return <div className={cls}>{children}</div>;
}

/* ---------- bottom sheet ---------- */

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  const [render, setRender] = useState(open);
  useEffect(() => {
    if (open) setRender(true);
    else {
      const t = setTimeout(() => setRender(false), 200);
      return () => clearTimeout(t);
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!render) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div
        className={`absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <div
        className={`relative w-full max-w-md rounded-t-3xl border-t border-white/10 bg-[#0d1424] p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl transition-transform duration-200 ease-out sm:rounded-3xl sm:border ${open ? 'translate-y-0' : 'translate-y-full sm:translate-y-4 sm:opacity-0'}`}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/15 sm:hidden" />
        {title && <h3 className="mb-4 text-base font-bold text-slate-100">{title}</h3>}
        {children}
      </div>
    </div>
  );
}

/** One tappable row inside an action sheet. */
export function SheetAction({
  icon,
  label,
  sub,
  onClick,
  danger,
  selected,
}: {
  icon: ReactNode;
  label: string;
  sub?: string;
  onClick: () => void;
  danger?: boolean;
  selected?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3.5 rounded-xl px-3 py-3 text-left transition-colors active:bg-white/10 ${danger ? 'text-red-300 hover:bg-red-500/10' : 'text-slate-100 hover:bg-white/6'}`}
    >
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg ${danger ? 'bg-red-500/10' : 'bg-white/6'}`}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{label}</span>
        {sub && <span className="block truncate text-xs text-slate-500">{sub}</span>}
      </span>
      {selected && <span className="text-sky-400">✓</span>}
    </button>
  );
}

/* ---------- forms ---------- */

export const inputClass =
  'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-[15px] text-slate-100 placeholder-slate-500 outline-none transition-colors focus:border-sky-500/60 focus:bg-white/8';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-slate-500">{label}</span>
      {children}
    </label>
  );
}

/** Bottom-sheet form with a single text input (rename / new folder / etc). */
export function InputSheet({
  open,
  onClose,
  title,
  placeholder,
  initial = '',
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  placeholder?: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (value: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setValue(initial);
      setError(null);
      setTimeout(() => ref.current?.focus(), 250);
    }
  }, [open, initial]);

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!value.trim()) return;
          setBusy(true);
          setError(null);
          try {
            await onSubmit(value.trim());
            onClose();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Something went wrong');
          } finally {
            setBusy(false);
          }
        }}
        className="space-y-4"
      >
        <input ref={ref} className={inputClass} value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button type="submit" kind="primary" full size="lg" disabled={busy || !value.trim()}>
          {busy ? 'Working…' : submitLabel}
        </Button>
      </form>
    </Sheet>
  );
}

/** Destructive confirmation sheet. */
export function ConfirmSheet({
  open,
  onClose,
  title,
  body,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <p className="mb-5 text-sm leading-relaxed text-slate-400">{body}</p>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      <div className="flex gap-3">
        <Button full onClick={onClose}>
          Cancel
        </Button>
        <Button
          full
          kind="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Something went wrong');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </div>
    </Sheet>
  );
}

/* ---------- misc ---------- */

export function EmptyState({ icon, title, sub }: { icon: string; title: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <span className="text-4xl opacity-40">{icon}</span>
      <p className="text-sm font-semibold text-slate-400">{title}</p>
      {sub && <p className="max-w-[26ch] text-xs text-slate-600">{sub}</p>}
    </div>
  );
}

export function Notice({ text, onDismiss }: { text: string; onDismiss?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
      <span className="min-w-0">{text}</span>
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 text-amber-400/60 hover:text-amber-200">
          ✕
        </button>
      )}
    </div>
  );
}

export function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/10 border-t-sky-400" />
    </div>
  );
}
