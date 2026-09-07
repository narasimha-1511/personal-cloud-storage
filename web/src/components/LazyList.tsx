import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Windowed list for potentially huge collections (a 600-video folder, a
 * 600-file upload queue). Renders an initial slice and grows as the user
 * approaches the end (IntersectionObserver, pre-armed 600px out), while
 * `content-visibility: auto` lets the browser skip layout/paint for rendered
 * rows that are offscreen. Rows should be memoized components so progress
 * ticks only re-render the rows whose data actually changed.
 *
 * Pass `limit`/`onLimitChange` to hoist the window size into the parent — the
 * library page does that so returning to a page can restore how far the user
 * had scrolled instead of collapsing back to the first screenful.
 */
export function LazyList<T>({
  items,
  keyFor,
  renderItem,
  initial = 30,
  step = 60,
  estimateHeight = 80,
  limit: controlledLimit,
  onLimitChange,
}: {
  items: T[];
  keyFor: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  initial?: number;
  step?: number;
  estimateHeight?: number;
  limit?: number;
  onLimitChange?: (next: number) => void;
}) {
  const [ownLimit, setOwnLimit] = useState(initial);
  const limit = controlledLimit ?? ownLimit;
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || limit >= items.length || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (onLimitChange) onLimitChange(limit + step);
        else setOwnLimit((l) => l + step);
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [limit, items.length, step, onLimitChange]);

  return (
    <>
      {items.slice(0, limit).map((item) => (
        <div
          key={keyFor(item)}
          style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${estimateHeight}px` }}
        >
          {renderItem(item)}
        </div>
      ))}
      {limit < items.length && (
        <div ref={sentinelRef} style={{ gridColumn: '1 / -1' }} className="py-3 text-center text-[12px] text-zinc-600">
          {items.length - limit} more…
        </div>
      )}
    </>
  );
}
