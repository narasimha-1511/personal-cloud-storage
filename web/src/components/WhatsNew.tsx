import { useEffect, useState } from 'react';
import { APP_VERSION, CHANGELOG } from '../changelog';
import { Button, Sheet } from './ui';

const SEEN_KEY = 'vv-seen-version';

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, APP_VERSION);
  } catch {}
}

/** Full release-notes sheet, openable from the account menu. */
export function WhatsNewSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="What's new">
      <div className="-mx-1 max-h-[60vh] space-y-5 overflow-y-auto px-1 pb-1">
        {CHANGELOG.map((r) => (
          <div key={r.version}>
            <div className="mb-1.5 flex items-baseline gap-2">
              <span className="rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-semibold text-zinc-300 tabular-nums">
                v{r.version}
              </span>
              <span className="text-[13px] font-semibold text-zinc-200">{r.title}</span>
              <span className="ml-auto text-[11px] text-zinc-600">{r.date}</span>
            </div>
            <ul className="space-y-1 pl-1">
              {r.changes.map((c, i) => (
                <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-zinc-400">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-zinc-600" />
                  {c}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

/**
 * Shows the release notes once, automatically, the first time this version
 * runs on the device (skipped on a brand-new install).
 */
export function WhatsNewAutoPrompt() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const seen = readSeen();
    if (seen === null) {
      // Fresh install: nothing to announce.
      writeSeen();
    } else if (seen !== APP_VERSION) {
      setOpen(true);
    }
  }, []);
  if (!open) return null;
  const latest = CHANGELOG[0]!;
  return (
    <Sheet
      open={open}
      onClose={() => {
        writeSeen();
        setOpen(false);
      }}
      title={`Updated to v${latest.version}`}
    >
      <p className="mb-2 text-[13px] font-semibold text-zinc-200">{latest.title}</p>
      <ul className="mb-5 space-y-1">
        {latest.changes.map((c, i) => (
          <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-zinc-400">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-zinc-600" />
            {c}
          </li>
        ))}
      </ul>
      <Button
        full
        kind="primary"
        onClick={() => {
          writeSeen();
          setOpen(false);
        }}
      >
        Nice
      </Button>
    </Sheet>
  );
}
