import type { FolderInfo, ProjectInfo, VideoInfo } from '@videovault/shared';

/**
 * In-memory cache of what a project/folder page was showing, so returning to it
 * (from the viewer, from Library, from Transfers) restores instantly instead of
 * refetching, re-signing every thumbnail URL and snapping back to the top.
 *
 * Deliberately module-level and not persisted: signed view URLs are short-lived
 * and the video list can change on the server, so the cache is only ever a
 * first paint — `ProjectPage` always revalidates in the background.
 */
export interface ProjectPageCache {
  project: ProjectInfo | null;
  folders: FolderInfo[];
  videos: VideoInfo[] | null;
  /** id -> signed view URL, shared by the grid thumbnails and the viewer. */
  thumbs: Record<string, string>;
  /**
   * Subset of `thumbs` whose URL is a real derivative rather than the original
   * standing in for one still being generated.
   */
  realThumbs: string[];
  /** Epoch ms at which the signed URLs in `thumbs` stop working. */
  thumbsExpireAt: number;
  scrollY: number;
  /** How many rows/tiles the windowed list had grown to. */
  limit: number;
  fetchedAt: number;
}

const EMPTY: ProjectPageCache = {
  project: null,
  folders: [],
  videos: null,
  thumbs: {},
  realThumbs: [],
  thumbsExpireAt: 0,
  scrollY: 0,
  limit: 0,
  fetchedAt: 0,
};

/** Enough to cover a project root plus the folders someone is bouncing between. */
const MAX_ENTRIES = 8;

const cache = new Map<string, ProjectPageCache>();

export function pageKey(projectId: string, folderId: string | null): string {
  return `${projectId}:${folderId ?? ''}`;
}

export function readPage(key: string): ProjectPageCache | null {
  const hit = cache.get(key);
  if (!hit) return null;
  // Re-insert so the Map's insertion order doubles as an LRU queue.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

/**
 * Merges into a cached page, creating the entry if absent.
 *
 * Pass `onlyIfPresent` for a write that must not resurrect an entry someone
 * else deleted — a response that arrives after the user left that folder and
 * then invalidated it would otherwise re-insert stale data under a zeroed
 * scroll position.
 */
export function writePage(
  key: string,
  patch: Partial<ProjectPageCache>,
  opts: { onlyIfPresent?: boolean } = {},
): void {
  const prev = cache.get(key);
  if (!prev && opts.onlyIfPresent) return;
  const next = { ...(prev ?? EMPTY), ...patch };
  cache.delete(key);
  cache.set(key, next);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * Drop other locations in the same project after a mutation — a move changes
 * two folders, and a delete changes the project's counts. The caller's own page
 * is left alone so its scroll position survives; its data is overwritten by the
 * reload that follows.
 */
export function invalidateSiblings(projectId: string, exceptKey: string): void {
  for (const key of [...cache.keys()]) {
    if (key !== exceptKey && key.startsWith(`${projectId}:`)) cache.delete(key);
  }
}

export function clearPageCache(): void {
  cache.clear();
}

/** Signed URLs are refused once expired; treat the last two minutes as gone. */
export function thumbsUsable(entry: ProjectPageCache): boolean {
  return entry.thumbsExpireAt > Date.now() + 120_000;
}
