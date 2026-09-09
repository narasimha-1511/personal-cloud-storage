import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoInfo } from '@videovault/shared';
import { api } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import { startVideoDownload } from '../lib/startDownload';
import { IconChevronLeft, IconChevronRight, IconDownload, IconFile, IconSpinner, IconX } from './icons';

export function kindOf(v: VideoInfo): 'video' | 'image' | 'audio' | 'file' {
  if (v.mimeType.startsWith('video/')) return 'video';
  if (v.mimeType.startsWith('image/')) return 'image';
  if (v.mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * Full-screen viewer rendered *over* the library instead of navigating to a
 * route. Keeping the page mounted is the whole point: closing the viewer costs
 * nothing — no refetch, no re-signed thumbnails, no scroll jump — and having
 * the sibling list in hand is what makes prev/next possible.
 *
 * URLs already signed for the grid are passed in via `urlHint` so a photo the
 * user can see opens with zero network round-trips; anything else is signed on
 * demand, one step ahead in each direction.
 */
export default function Lightbox({
  items,
  index,
  onIndex,
  onClose,
  previewHint,
  onError,
  onToast,
}: {
  items: VideoInfo[];
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
  /** id -> grid thumbnail URL, shown instantly while the original downloads. */
  previewHint?: Record<string, string>;
  onError: (msg: string) => void;
  onToast: (msg: string) => void;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [decoded, setDecoded] = useState<Set<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const current = items[index];

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next >= 0 && next < items.length) onIndex(next);
    },
    [index, items.length, onIndex],
  );

  /**
   * Resolve a URL to display for one file, and its immediate neighbours so a
   * click on the arrow shows the next photo rather than a spinner.
   *
   * Images are shown as their display-sized derivative, never the original: a
   * 40 MP phone photo is several megabytes to fetch and ~160 MB to decode,
   * which is slow on a laptop and painful on a phone. If that copy does not
   * exist yet the request itself queues it, so we wait briefly and only fall
   * back to the original if it really has not arrived. Videos and other files
   * always stream the original.
   */
  useEffect(() => {
    let cancelled = false;

    const resolve = async (v: VideoInfo, attempt = 0): Promise<void> => {
      if (cancelled) return;
      try {
        if (kindOf(v) !== 'image') {
          const r = await api.viewUrl(v.id);
          if (!cancelled) setUrls((u) => ({ ...u, [v.id]: r.url }));
          return;
        }
        const r = await api.viewUrls([v.id], 'preview');
        const url = r.urls[v.id];
        if (url) {
          if (!cancelled) setUrls((u) => ({ ...u, [v.id]: url }));
          return;
        }
        // Still being generated. Give it a few seconds — the thumbnail is on
        // screen meanwhile — then take the original rather than hang.
        if (r.pending.includes(v.id) && attempt < 4) {
          await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
          return resolve(v, attempt + 1);
        }
        const fallback = await api.viewUrl(v.id);
        if (!cancelled) setUrls((u) => ({ ...u, [v.id]: fallback.url }));
      } catch {
        inFlight.current.delete(v.id);
        if (!cancelled && v.id === items[index]?.id) onError('Could not open this file');
      }
    };

    for (const v of [items[index], items[index - 1], items[index + 1]]) {
      if (!v || urls[v.id] || inFlight.current.has(v.id)) continue;
      inFlight.current.add(v.id);
      void resolve(v);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, items]);

  // Warm the neighbours' full-resolution bytes in the browser cache. Stepping
  // through a folder then costs a cache hit rather than a fresh download, and
  // the current photo can crossfade the instant it has decoded.
  const preloading = useRef(new Set<string>());
  useEffect(() => {
    let cancelled = false;
    for (const v of [items[index], items[index - 1], items[index + 1]]) {
      if (!v || kindOf(v) !== 'image') continue;
      const url = urls[v.id];
      // Without the in-flight guard every state change here would start another
      // decode of the same bytes on the main thread.
      if (!url || decoded.has(v.id) || preloading.current.has(v.id)) continue;
      preloading.current.add(v.id);
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      img.decode().then(
        () => {
          if (!cancelled) setDecoded((d) => (d.has(v.id) ? d : new Set(d).add(v.id)));
        },
        () => {
          // Leave it undecoded: the preview stays up rather than being replaced
          // by a broken image, and a later pass may still succeed.
          preloading.current.delete(v.id);
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [index, items, urls, decoded]);

  // Keyboard: arrows step, Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onClose]);

  // Freeze the library behind the overlay; `overflow: hidden` keeps its scroll
  // offset, which is exactly what we want to hand back on close.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Horizontal swipe steps; a mostly-vertical drag is left alone.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.changedTouches[0];
    touch.current = t ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touch.current;
    const t = e.changedTouches[0];
    touch.current = null;
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  };

  if (!current) return null;
  const url = urls[current.id] ?? null;
  const preview = previewHint?.[current.id] ?? null;
  const kind = kindOf(current);
  const full = kind === 'image' && url !== null && decoded.has(current.id);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={current.displayName}
    >
      <header className="flex shrink-0 items-center gap-3 px-3 pt-[calc(env(safe-area-inset-top)+0.5rem)] pb-2 sm:px-5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-zinc-100">{current.displayName}</p>
          <p className="truncate text-[11px] text-zinc-500 tabular-nums">
            {index + 1} of {items.length} · {formatBytes(current.size)} · {formatDate(current.createdAt)}
          </p>
        </div>
        <button
          onClick={() =>
            void startVideoDownload(current)
              .then((mode) => {
                if (mode === 'managed') onToast('Download started — track it in Transfers');
                if (mode === 'native') onToast('Download handed to the browser');
              })
              .catch((err) => onError(err instanceof Error ? err.message : 'Download failed'))
          }
          className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
          aria-label={`Download ${current.displayName}`}
        >
          <IconDownload size={18} />
        </button>
        <button
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
          aria-label="Close viewer"
        >
          <IconX size={18} />
        </button>
      </header>

      <div className="relative min-h-0 flex-1" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {/* Tapping the backdrop closes; the media itself does not. */}
        <button className="absolute inset-0 cursor-default" onClick={onClose} aria-label="Close viewer" tabIndex={-1} />

        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-3 sm:p-8">
          {!url && !preview && (
            <span className="text-zinc-600">
              <IconSpinner size={26} />
            </span>
          )}
          {kind === 'image' && (
            // The grid's thumbnail stands in — upscaled and softened — until the
            // original has decoded, so opening a photo is never a blank wait.
            //
            // Both images fill the same box and are laid out with object-contain,
            // so the 512px stand-in occupies exactly the rectangle the original
            // will. Sizing the box to its content instead would render the
            // stand-in at its own small natural size and then visibly jump when
            // the original arrived. `key` keeps each file's elements distinct so
            // the previous photo cannot linger over the next one.
            <div key={current.id} className="pointer-events-auto relative h-full w-full">
              {preview && !full && (
                <img
                  src={preview}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 h-full w-full scale-[1.01] object-contain blur-[2px]"
                />
              )}
              {url && (
                <img
                  src={url}
                  alt={current.displayName}
                  decoding="async"
                  className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${
                    full ? 'opacity-100' : 'opacity-0'
                  }`}
                />
              )}
              {!full && (
                <span className="absolute bottom-0 right-0 text-zinc-400">
                  <IconSpinner size={18} />
                </span>
              )}
            </div>
          )}
          {url && kind === 'video' && (
            <video
              key={current.id}
              src={url}
              poster={preview ?? undefined}
              controls
              autoPlay
              playsInline
              className="pointer-events-auto max-h-full max-w-full rounded-lg bg-black"
            />
          )}
          {url && kind === 'audio' && (
            <audio key={current.id} src={url} controls autoPlay className="pointer-events-auto w-full max-w-md" />
          )}
          {url && kind === 'file' && (
            <div className="pointer-events-auto flex flex-col items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-10 py-14">
              <span className="text-zinc-600">
                <IconFile size={36} />
              </span>
              <p className="text-[13px] text-zinc-400">No preview for this file type — download to open it.</p>
            </div>
          )}
        </div>

        <ArrowButton side="left" disabled={index === 0} onClick={() => go(-1)} />
        <ArrowButton side="right" disabled={index >= items.length - 1} onClick={() => go(1)} />
      </div>
    </div>
  );
}

function ArrowButton({ side, disabled, onClick }: { side: 'left' | 'right'; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={side === 'left' ? 'Previous file' : 'Next file'}
      className={`absolute top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/60 text-zinc-200 backdrop-blur transition hover:bg-black/80 hover:text-white disabled:pointer-events-none disabled:opacity-0 sm:h-14 sm:w-14 ${
        side === 'left' ? 'left-2 sm:left-5' : 'right-2 sm:right-5'
      }`}
    >
      {side === 'left' ? <IconChevronLeft size={22} /> : <IconChevronRight size={22} />}
    </button>
  );
}
