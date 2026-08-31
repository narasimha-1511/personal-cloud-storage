import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconSpinner } from './icons';

/*
 * Design language: flat near-black surfaces, hairline borders, one accent
 * (blue) used sparingly. No gradients, no glow shadows, no emoji.
 */

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
    default: 'border border-white/10 bg-white/[0.06] text-zinc-100 hover:bg-white/10',
    primary: 'bg-blue-600 text-white hover:bg-blue-500',
    danger: 'border border-red-500/25 bg-transparent text-red-400 hover:bg-red-500/10',
    ghost: 'bg-transparent text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
  } as const;
  const sizes = { md: 'h-9 px-3.5 text-[13px]', lg: 'h-12 px-5 text-[15px]' } as const;
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors active:opacity-80 disabled:cursor-not-allowed disabled:opacity-40 ${styles[kind]} ${sizes[size]} ${full ? 'w-full' : ''}`}
    >
      {children}
    </button>
  );
}

/* ---------- segmented control ---------- */

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-lg border border-white/10 bg-black/30 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`h-8 flex-1 rounded-[7px] text-[13px] font-medium transition-colors ${
            value === o.value ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- status ---------- */

const CHIP: Record<string, { cls: string; label: string; busy?: boolean }> = {
  queued: { cls: 'text-zinc-400', label: 'Queued' },
  uploading: { cls: 'text-blue-400', label: 'Uploading', busy: true },
  downloading: { cls: 'text-blue-400', label: 'Downloading', busy: true },
  paused: { cls: 'text-zinc-400', label: 'Paused' },
  waiting_network: { cls: 'text-amber-400', label: 'Waiting for network', busy: true },
  needs_file: { cls: 'text-amber-400', label: 'Tap to resume' },
  completing: { cls: 'text-blue-400', label: 'Finishing', busy: true },
  done: { cls: 'text-emerald-400', label: 'Done' },
  error: { cls: 'text-red-400', label: 'Failed' },
  aborted: { cls: 'text-zinc-500', label: 'Cancelled' },
  READY: { cls: 'text-emerald-400', label: 'Ready' },
  UPLOADING: { cls: 'text-blue-400', label: 'Uploading', busy: true },
  FAILED: { cls: 'text-red-400', label: 'Failed' },
  ABORTED: { cls: 'text-zinc-500', label: 'Cancelled' },
};

export function StatusChip({ state }: { state: string }) {
  const c = CHIP[state] ?? { cls: 'text-zinc-400', label: state };
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium ${c.cls}`}>
      {c.busy && <IconSpinner size={11} />}
      {c.label}
    </span>
  );
}

export function ProgressBar({ value, tone = 'blue' }: { value: number; tone?: 'blue' | 'emerald' | 'amber' }) {
  const colors = { blue: 'bg-blue-500', emerald: 'bg-emerald-500', amber: 'bg-amber-500' } as const;
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.07]">
      <div
        className={`h-full rounded-full transition-[width] duration-500 ease-out ${colors[tone]}`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

/* ---------- surfaces ---------- */

export function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4">{children}</div>;
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
      const t = setTimeout(() => setRender(false), 180);
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
        className={`absolute inset-0 bg-black/60 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <div
        className={`relative w-full max-w-md rounded-t-2xl border-t border-white/10 bg-[#131316] p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] transition-transform duration-200 ease-out sm:rounded-2xl sm:border ${open ? 'translate-y-0' : 'translate-y-full sm:translate-y-3 sm:opacity-0'}`}
      >
        <div className="mx-auto mb-4 h-1 w-9 rounded-full bg-white/15 sm:hidden" />
        {title && <h3 className="mb-4 truncate pr-4 text-[15px] font-semibold text-zinc-100">{title}</h3>}
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
      className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors ${danger ? 'text-red-400 hover:bg-red-500/8' : 'text-zinc-100 hover:bg-white/[0.06]'}`}
    >
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center ${danger ? 'text-red-400' : 'text-zinc-400'}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium">{label}</span>
        {sub && <span className="mt-0.5 block truncate text-[12px] text-zinc-500">{sub}</span>}
      </span>
      {selected && (
        <span className="text-blue-400">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
      )}
    </button>
  );
}

/* ---------- forms ---------- */

export const inputClass =
  'h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3.5 text-[15px] text-zinc-100 placeholder-zinc-600 outline-none transition-colors focus:border-blue-500/60';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-zinc-500">{label}</span>
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
      setTimeout(() => ref.current?.focus(), 220);
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
      <p className="mb-5 text-[13px] leading-relaxed text-zinc-400">{body}</p>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      <div className="flex gap-2.5">
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

export function EmptyState({ icon, title, sub }: { icon: ReactNode; title: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center gap-2.5 py-14 text-center">
      <span className="text-zinc-700">{icon}</span>
      <p className="text-[13px] font-medium text-zinc-500">{title}</p>
      {sub && <p className="max-w-[28ch] text-[12px] leading-relaxed text-zinc-600">{sub}</p>}
    </div>
  );
}

export function Notice({ text, onDismiss }: { text: string; onDismiss?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-3.5 py-2.5 text-[13px] text-amber-300">
      <span className="min-w-0">{text}</span>
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 text-amber-500/60 hover:text-amber-300">
          ✕
        </button>
      )}
    </div>
  );
}

export function Spinner() {
  return (
    <div className="flex justify-center py-12 text-zinc-600">
      <IconSpinner size={20} />
    </div>
  );
}
