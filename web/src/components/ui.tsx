import type { ReactNode } from 'react';

export function ProgressBar({ value, tone = 'sky' }: { value: number; tone?: 'sky' | 'emerald' | 'amber' }) {
  const colors = { sky: 'bg-sky-500', emerald: 'bg-emerald-500', amber: 'bg-amber-500' } as const;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
      <div
        className={`h-full rounded-full transition-[width] duration-300 ${colors[tone]}`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

const CHIP_STYLES: Record<string, string> = {
  queued: 'bg-slate-700 text-slate-200',
  uploading: 'bg-sky-900 text-sky-200',
  downloading: 'bg-sky-900 text-sky-200',
  paused: 'bg-slate-700 text-slate-300',
  waiting_network: 'bg-amber-900 text-amber-200',
  needs_file: 'bg-amber-900 text-amber-200',
  completing: 'bg-indigo-900 text-indigo-200',
  done: 'bg-emerald-900 text-emerald-200',
  error: 'bg-red-900 text-red-200',
  aborted: 'bg-slate-800 text-slate-400',
  READY: 'bg-emerald-900 text-emerald-200',
  UPLOADING: 'bg-sky-900 text-sky-200',
  FAILED: 'bg-red-900 text-red-200',
  ABORTED: 'bg-slate-800 text-slate-400',
};

const CHIP_LABELS: Record<string, string> = {
  queued: 'Waiting',
  uploading: 'Uploading',
  downloading: 'Downloading',
  paused: 'Paused',
  waiting_network: 'Waiting for connection',
  needs_file: 'Tap to resume',
  completing: 'Completing…',
  done: 'Ready',
  error: 'Failed',
  aborted: 'Cancelled',
  READY: 'Ready',
  UPLOADING: 'Uploading',
  FAILED: 'Failed',
  ABORTED: 'Cancelled',
};

export function StatusChip({ state }: { state: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${CHIP_STYLES[state] ?? 'bg-slate-700 text-slate-200'}`}>
      {CHIP_LABELS[state] ?? state}
    </span>
  );
}

export function Button({
  children,
  onClick,
  kind = 'default',
  disabled,
  type = 'button',
  full,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  type?: 'button' | 'submit';
  full?: boolean;
}) {
  const styles = {
    default: 'bg-slate-700 hover:bg-slate-600 text-slate-100',
    primary: 'bg-sky-600 hover:bg-sky-500 text-white',
    danger: 'bg-red-800 hover:bg-red-700 text-red-100',
    ghost: 'bg-transparent hover:bg-slate-800 text-slate-300',
  } as const;
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles[kind]} ${full ? 'w-full' : ''}`}
    >
      {children}
    </button>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">{children}</div>;
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none';
