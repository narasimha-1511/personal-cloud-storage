import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LazyList } from '../components/LazyList';
import Lightbox from '../components/Lightbox';
import { useParams, useSearchParams } from 'react-router-dom';
import type { FolderInfo, ProjectInfo, UserInfo, VideoInfo } from '@videovault/shared';
import { api } from '../lib/api';
import { invalidateSiblings, pageKey, readPage, thumbsUsable, writePage } from '../lib/pageCache';
import { ensureManagersInit, uploadManager, useUploads } from '../lib/managers';
import { startVideoDownload } from '../lib/startDownload';
import { filesFromDataTransfer } from '../lib/dropFiles';
import { formatBytes, formatDate, formatEta, formatSpeed, percent } from '../lib/format';
import { useAuth } from '../auth';
import Layout from '../components/Layout';
import {
  Button,
  ConfirmSheet,
  EmptyState,
  InputSheet,
  Notice,
  ProgressBar,
  Sheet,
  SheetAction,
  Spinner,
  StatusChip,
} from '../components/ui';
import {
  IconCheck,
  IconDownload,
  IconEyeOff,
  IconFile,
  IconFilm,
  IconFolder,
  IconFolderMove,
  IconHome,
  IconImage,
  IconGrid,
  IconLink,
  IconList,
  IconLock,
  IconMore,
  IconPencil,
  IconPlay,
  IconPlus,
  IconTrash,
} from '../components/icons';

// Shown as inline progress cards; queued files are summarized in one line
// instead of rendering a card each (a 600-file selection would be 600 cards).
const INLINE_STATES = ['uploading', 'completing', 'waiting_network', 'paused', 'needs_file'];

export default function ProjectPage() {
  const { projectId = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const folderId = search.get('f');
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [videos, setVideos] = useState<VideoInfo[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [videoMenu, setVideoMenu] = useState<VideoInfo | null>(null);
  const [moving, setMoving] = useState<VideoInfo[] | null>(null);
  const [renamingVideo, setRenamingVideo] = useState<VideoInfo | null>(null);
  const [deletingVideos, setDeletingVideos] = useState<VideoInfo[] | null>(null);
  const [folderMenu, setFolderMenu] = useState<FolderInfo | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<FolderInfo | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<FolderInfo | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [accessFolder, setAccessFolder] = useState<FolderInfo | null>(null);

  // multi-select
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Viewer overlay. Held by id rather than index so the open/next handlers stay
  // referentially stable and the memoized tiles do not re-render on every keystroke.
  const [viewerId, setViewerId] = useState<string | null>(null);

  // filters
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'READY' | 'UPLOADING'>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'video' | 'image' | 'other'>('all');
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'largest' | 'name'>('newest');

  // list/grid view (grid shows real photo thumbnails)
  const [viewMode, setViewModeState] = useState<'list' | 'grid'>(() => {
    try {
      return localStorage.getItem('vv-viewmode') === 'grid' ? 'grid' : 'list';
    } catch {
      return 'list';
    }
  });
  const setViewMode = (m: 'list' | 'grid') => {
    setViewModeState(m);
    try {
      localStorage.setItem('vv-viewmode', m);
    } catch {}
  };
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [thumbsExpireAt, setThumbsExpireAt] = useState(0);
  /**
   * Ids whose URL is a genuine thumbnail rather than the original standing in
   * for one still being generated. The viewer uses this to avoid showing (and
   * separately re-downloading) a multi-megabyte original as a "preview".
   */
  const [realThumbs, setRealThumbs] = useState<Set<string>>(new Set());
  // Ids already asked for, so the effect never re-requests the same URL.
  const thumbsRequested = useRef(new Set<string>());
  // Bumped to force a fresh round after signed URLs expire.
  const [thumbEpoch, setThumbEpoch] = useState(0);

  const fileInput = useRef<HTMLInputElement>(null);
  const recordInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const uploads = useUploads();
  const startedHere = useRef(new Map<string, string>());
  const hereKey = `${projectId}:${folderId ?? ''}`;
  const localUploads = uploads.filter(
    (u) => INLINE_STATES.includes(u.state) && startedHere.current.get(u.localId) === hereKey,
  );
  const queuedHere = uploads.filter(
    (u) => u.state === 'queued' && startedHere.current.get(u.localId) === hereKey,
  ).length;

  const currentFolder = folders.find((f) => f.id === folderId) ?? null;
  const canModify = useCallback((v: VideoInfo) => isAdmin || v.ownerId === user?.id, [isAdmin, user?.id]);

  // How far the windowed list has grown, hoisted here so it can be cached.
  const defaultLimit = viewMode === 'grid' ? 60 : 30;
  const [limit, setLimit] = useState(defaultLimit);

  const cacheKey = pageKey(projectId, folderId);
  // The location a response must still belong to before it is applied, so a
  // slow request for the folder you just left cannot overwrite the new one.
  const liveKey = useRef(cacheKey);
  const pendingScroll = useRef<number | null>(null);
  // True while the restore is stepping toward the saved offset, so the scroll
  // listener does not record the clamped positions it passes through.
  const restoring = useRef(false);

  const load = useCallback(async () => {
    const key = pageKey(projectId, folderId);
    const [projectsRes, foldersRes, videosRes] = await Promise.allSettled([
      api.listProjects(),
      api.listFolders(projectId),
      api.listVideos({ projectId, folderId: folderId ?? 'none' }),
    ]);
    const fresh = liveKey.current === key;

    const proj =
      projectsRes.status === 'fulfilled'
        ? (projectsRes.value.projects.find((p) => p.id === projectId) ?? null)
        : undefined;
    const nextFolders = foldersRes.status === 'fulfilled' ? foldersRes.value.folders : undefined;
    const nextVideos = videosRes.status === 'fulfilled' ? videosRes.value.videos : undefined;

    if (fresh) {
      if (proj !== undefined) setProject(proj);
      if (nextFolders !== undefined) setFolders(nextFolders);
      if (nextVideos !== undefined) setVideos(nextVideos);
    }
    // Cache under the key the request was made for, even if we navigated away —
    // but never re-create an entry that was invalidated while this was in
    // flight, or the stale counts would outlive the invalidation.
    writePage(
      key,
      {
        ...(proj !== undefined ? { project: proj } : {}),
        ...(nextFolders !== undefined ? { folders: nextFolders } : {}),
        ...(nextVideos !== undefined ? { videos: nextVideos } : {}),
        fetchedAt: Date.now(),
      },
      { onlyIfPresent: !fresh },
    );

    if (fresh && videosRes.status === 'rejected') {
      setNotice('Could not load files — check your connection.');
    } else if (fresh && nextVideos !== undefined) {
      setNotice(null);
    }
  }, [projectId, folderId]);

  /** Reload after a mutation, dropping sibling folders whose counts moved. */
  const refresh = useCallback(() => {
    invalidateSiblings(projectId, pageKey(projectId, folderId));
    void load();
  }, [projectId, folderId, load]);

  // Paint from cache first, then revalidate. Restoring `videos` (rather than
  // blanking to a spinner) is what keeps the scroll position meaningful.
  useEffect(() => {
    void ensureManagersInit();
    liveKey.current = cacheKey;
    setSelectMode(false);
    setSelected(new Set());
    setViewerId(null);
    thumbsRequested.current = new Set();

    const hit = readPage(cacheKey);
    if (hit) {
      setProject(hit.project);
      setFolders(hit.folders);
      setVideos(hit.videos);
      const keepThumbs = thumbsUsable(hit);
      setThumbs(keepThumbs ? hit.thumbs : {});
      setThumbsExpireAt(keepThumbs ? hit.thumbsExpireAt : 0);
      setRealThumbs(keepThumbs ? new Set(hit.realThumbs) : new Set());
      // Only ids whose URL is a finished thumbnail are considered done; ones
      // still standing in for a pending derivative must be asked about again.
      if (keepThumbs) thumbsRequested.current = new Set(hit.realThumbs);
      setLimit(hit.limit || defaultLimit);
      pendingScroll.current = hit.scrollY;
    } else {
      setProject(null);
      setFolders([]);
      setVideos(null);
      setThumbs({});
      setThumbsExpireAt(0);
      setRealThumbs(new Set());
      setLimit(defaultLimit);
      pendingScroll.current = 0;
    }
    void load();
    // `defaultLimit` follows viewMode, which must not re-trigger a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, load]);

  // Put the user back where they were, once the restored rows are in the DOM.
  //
  // A single scrollTo is not enough and is actively harmful: `content-visibility`
  // only gives a row its true height once it nears the viewport, so a freshly
  // mounted document is much shorter than it will be and the browser clamps the
  // jump. Each clamped landing unlocks more rows, so we step toward the target
  // across frames while progress is still being made. `restoring` suppresses the
  // scroll listener throughout — otherwise the clamped intermediate positions
  // would be written straight over the saved one, permanently losing the place.
  useLayoutEffect(() => {
    if (pendingScroll.current === null || videos === null) return;
    const y = pendingScroll.current;
    pendingScroll.current = null;
    if (y <= 0) return;

    restoring.current = true;
    let raf = 0;
    let tries = 0;
    let lastReached = -1;
    const step = () => {
      window.scrollTo(0, y);
      const reached = window.scrollY;
      tries++;
      const arrived = Math.abs(reached - y) <= 2;
      const stalled = reached === lastReached;
      lastReached = reached;
      if (!arrived && !stalled && tries < 40) {
        raf = requestAnimationFrame(step);
      } else {
        restoring.current = false;
        // Keep whatever we could actually reach, so the next visit is closer.
        writePage(liveKey.current, { scrollY: reached });
      }
    };
    step();
    return () => {
      cancelAnimationFrame(raf);
      restoring.current = false;
    };
  }, [videos]);

  // Track scroll for the cache. rAF-throttled so a fling costs one write a frame.
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (pendingScroll.current !== null || restoring.current) return;
        writePage(liveKey.current, { scrollY: window.scrollY });
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
      if (window.scrollY > 0 && !restoring.current) {
        writePage(liveKey.current, { scrollY: window.scrollY });
      }
    };
  }, []);

  useEffect(() => {
    writePage(cacheKey, { limit });
  }, [cacheKey, limit]);

  // Thumbs and their expiry are written together: a mismatched pair would make
  // the next visit either discard usable URLs or trust expired ones.
  useEffect(() => {
    writePage(cacheKey, { thumbs, thumbsExpireAt, realThumbs: [...realThumbs] });
  }, [cacheKey, thumbs, thumbsExpireAt, realThumbs]);

  // Drag & drop anywhere on the page uploads into the current location.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (!e.dataTransfer) return;
      void filesFromDataTransfer(e.dataTransfer).then((files) => {
        if (files.length > 0) void addFiles(files);
      });
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, folderId]);

  // Refresh when an upload completes so the new video flips to Ready.
  const doneCount = uploads.filter((u) => u.state === 'done').length;
  const prevDone = useRef(doneCount);
  useEffect(() => {
    if (doneCount > prevDone.current) refresh();
    prevDone.current = doneCount;
  }, [doneCount, refresh]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  async function addFiles(files: FileList | File[]) {
    setNotice(null);
    try {
      // One batched request; duplicates are skipped and interrupted uploads
      // matching a picked file resume instead of re-registering.
      const result = await uploadManager.addFiles(
        Array.from(files).map((file) => ({ file })),
        { projectId, folderId },
      );
      for (const localId of result.localIds) {
        startedHere.current.set(localId, `${projectId}:${folderId ?? ''}`);
      }
      const parts: string[] = [];
      if (result.queued > 0) parts.push(`${result.queued} queued`);
      if (result.resumed > 0) parts.push(`${result.resumed} resumed`);
      if (result.skipped > 0) parts.push(`${result.skipped} already uploaded — skipped`);
      showToast(parts.length > 0 ? parts.join(' · ') : 'Nothing to upload');
      refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not start uploads');
    }
  }

  async function downloadSelected() {
    const ready = selectedVideos.filter((v) => v.status === 'READY');
    if (ready.length === 0) {
      setNotice('None of the selected files are ready to download yet.');
      return;
    }
    try {
      if ('showDirectoryPicker' in window) {
        const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
        const { downloadManager } = await import('../lib/managers');
        await downloadManager.startBatch(
          ready.map((v) => ({ id: v.id, displayName: v.displayName, size: v.size })),
          dir,
        );
        showToast(`${ready.length} download${ready.length === 1 ? '' : 's'} queued — track in Transfers`);
      } else {
        // Fallback: hand each file to the browser's own download manager.
        for (const v of ready) {
          const { url } = await api.downloadUrl(v.id);
          const a = document.createElement('a');
          a.href = url;
          a.download = v.displayName;
          a.click();
        }
        showToast(`${ready.length} download${ready.length === 1 ? '' : 's'} handed to the browser`);
      }
      exitSelect();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setNotice(err instanceof Error ? err.message : 'Could not start downloads');
    }
  }

  // Stable handlers so memoized rows only re-render when their own data changes.
  const onRowToggle = useCallback((v: VideoInfo) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(v.id)) next.delete(v.id);
      else next.add(v.id);
      return next;
    });
  }, []);
  // Opens the in-page viewer rather than navigating to /watch — leaving this
  // page mounted is what makes closing the viewer free.
  const onRowPlay = useCallback((v: VideoInfo) => setViewerId(v.id), []);

  function exitSelect() {
    setSelectMode(false);
    setSelected(new Set());
  }

  const isSelectable = useCallback(
    (v: VideoInfo) => canModify(v) || v.status === 'READY',
    [canModify],
  );
  const selectedVideos = (videos ?? []).filter((v) => selected.has(v.id));
  const selectableCount = (videos ?? []).filter(isSelectable).length;
  const allModifiable = selectedVideos.length > 0 && selectedVideos.every(canModify);
  const readySelected = selectedVideos.filter((v) => v.status === 'READY').length;

  const q = query.trim().toLowerCase();
  // Memoized because these arrays are handed to the windowed list and the
  // viewer: a fresh identity on every keystroke would re-run the viewer's
  // preload effects and defeat the memoized tiles.
  const filteredVideos = useMemo(
    () =>
      (videos ?? [])
        .filter((v) => {
          if (typeFilter === 'all') return true;
          if (typeFilter === 'video') return v.mimeType.startsWith('video/');
          if (typeFilter === 'image') return v.mimeType.startsWith('image/');
          return !v.mimeType.startsWith('video/') && !v.mimeType.startsWith('image/');
        })
        .filter((v) => (statusFilter === 'all' ? true : v.status === statusFilter))
        .filter((v) => (q ? v.displayName.toLowerCase().includes(q) : true))
        .sort((a, b) => {
          switch (sortBy) {
            case 'oldest':
              return a.createdAt.localeCompare(b.createdAt);
            case 'largest':
              return b.size - a.size;
            case 'name':
              return a.displayName.localeCompare(b.displayName);
            default:
              return b.createdAt.localeCompare(a.createdAt);
          }
        }),
    [videos, typeFilter, statusFilter, q, sortBy],
  );

  // What the viewer can step through: everything currently listed that is
  // actually openable, in the order shown on screen.
  const viewable = useMemo(() => filteredVideos.filter((v) => v.status === 'READY'), [filteredVideos]);
  const viewerIndex = viewerId ? viewable.findIndex((v) => v.id === viewerId) : -1;

  /**
   * Low-resolution stand-ins for the viewer. Restricted to genuine thumbnails:
   * for a photo whose derivative is still being generated the grid URL is the
   * original itself, and handing that to the viewer as a "preview" would show a
   * multi-megabyte file and then download it a second time under a separately
   * signed URL.
   */
  const previews = useMemo(() => {
    const out: Record<string, string> = {};
    for (const id of realThumbs) {
      const url = thumbs[id];
      if (url) out[id] = url;
    }
    return out;
  }, [thumbs, realThumbs]);

  /**
   * Sign thumbnails for the rendered window, in server-sized chunks, growing as
   * the user scrolls.
   *
   * The in-flight work deliberately outlives any single run of this effect. A
   * derivative that does not exist yet is reported by the server as `pending`
   * (with the original standing in meanwhile), and we re-ask on a backoff until
   * it flips to the small file. If those retry timers were torn down by the
   * effect's cleanup they would be cancelled by the very `setThumbs` that
   * scheduled them — the poll would never fire even once and the grid would
   * keep serving full-size originals forever. So cancellation is tied to
   * leaving the folder, not to re-rendering.
   */
  const thumbTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = thumbTimers.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, [cacheKey]);

  useEffect(() => {
    if (viewMode !== 'grid' || !videos) return;
    if (thumbsExpireAt > 0 && Date.now() > thumbsExpireAt - 120_000) {
      // Signed URLs went stale — drop them and let this effect re-run.
      thumbsRequested.current = new Set();
      setThumbs({});
      setRealThumbs(new Set());
      setThumbsExpireAt(0);
      return;
    }
    const wanted = filteredVideos
      .slice(0, limit + 24)
      .filter((v) => v.status === 'READY' && v.mimeType.startsWith('image/') && !thumbsRequested.current.has(v.id))
      .map((v) => v.id);
    if (wanted.length === 0) return;
    for (const id of wanted) thumbsRequested.current.add(id);

    const key = liveKey.current;
    const stale = () => liveKey.current !== key;

    const fetchChunk = async (chunk: string[], attempt: number): Promise<void> => {
      if (stale()) return;
      try {
        const r = await api.viewUrls(chunk, 'thumb');
        if (stale()) return;
        setThumbsExpireAt(Date.parse(r.expiresAt));
        setThumbs((t) => ({ ...t, ...r.urls }));
        // The server names the ids it served a genuine derivative for. Anything
        // else in `urls` is an original it will never have a thumbnail for, and
        // must not be treated as a cheap preview.
        if (r.thumbed.length > 0) {
          setRealThumbs((s) => {
            const next = new Set(s);
            for (const id of r.thumbed) next.add(id);
            return next;
          });
        }
        if (r.pending.length > 0) {
          // Keep asking until every tile has its thumbnail. There is no attempt
          // limit on purpose: giving up used to leave those tiles showing a
          // placeholder indefinitely, because nothing re-triggers this effect
          // while a user simply looks at the grid. Backing off to a few seconds
          // keeps a big folder cheap to wait on.
          const delay = Math.min(700 * 2 ** attempt, 5000);
          const timer = setTimeout(() => {
            thumbTimers.current.delete(timer);
            // A hidden tab should not poll; the visibility listener restarts it.
            if (typeof document !== 'undefined' && document.hidden) {
              for (const id of r.pending) thumbsRequested.current.delete(id);
              return;
            }
            void fetchChunk(r.pending, attempt + 1);
          }, delay);
          thumbTimers.current.add(timer);
        }
      } catch {
        // Let them be retried on the next pass rather than sticking forever.
        for (const id of chunk) thumbsRequested.current.delete(id);
      }
    };

    for (let i = 0; i < wanted.length; i += 200) {
      void fetchChunk(wanted.slice(i, i + 200), 0);
    }
    // `filteredVideos` is derived from exactly these deps. `thumbs` is
    // deliberately absent: `thumbsRequested` already dedupes, and depending on
    // it would restart this effect on every response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, videos, limit, query, statusFilter, typeFilter, sortBy, thumbsExpireAt, thumbEpoch, cacheKey]);

  // Polling stops while the tab is in the background; pick it back up on
  // return, otherwise tiles left mid-generation would stay blank.
  useEffect(() => {
    if (viewMode !== 'grid') return;
    const onVisible = () => {
      if (!document.hidden) setThumbEpoch((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [viewMode]);

  // Nothing re-runs the effect above while a grid simply sits open, so expiring
  // URLs would quietly become 403s. Nudge it as the hour is nearly up.
  useEffect(() => {
    if (viewMode !== 'grid' || thumbsExpireAt <= 0) return;
    const due = thumbsExpireAt - 120_000 - Date.now();
    const timer = setTimeout(() => setThumbEpoch((n) => n + 1), Math.max(due, 1000));
    return () => clearTimeout(timer);
  }, [viewMode, thumbsExpireAt]);

  async function doMove(targets: VideoInfo[], target: string | null, targetName: string) {
    setMoving(null);
    let moved = 0;
    try {
      for (const v of targets) {
        if (v.folderId !== target) {
          await api.moveVideo(v.id, { folderId: target });
          moved++;
        }
      }
      showToast(moved === 1 ? `Moved to ${targetName}` : `${moved} videos moved to ${targetName}`);
      exitSelect();
      refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Move failed');
      refresh();
    }
  }

  const title = currentFolder ? currentFolder.name : (project?.name ?? '…');
  const backTo = currentFolder ? `/p/${projectId}` : '/';

  return (
    <Layout title={title} back={backTo}>
      <div className="space-y-6">
        {notice && <Notice text={notice} onDismiss={() => setNotice(null)} />}

        {currentFolder && (
          <p className="-mt-2 flex items-center gap-1.5 text-[12px] text-zinc-600">
            {project?.name} <span className="text-zinc-700">/</span> <span className="text-zinc-400">{currentFolder.name}</span>
          </p>
        )}

        {/* uploads running for THIS location */}
        {(localUploads.length > 0 || queuedHere > 0) && (
          <div className="space-y-2">
            {localUploads.map((u) => (
              <div key={u.localId} className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4">
                <div className="mb-2.5 flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-[13px] font-medium">{u.filename}</p>
                  <StatusChip state={u.state} />
                </div>
                <ProgressBar value={percent(u.bytesUploaded, u.size)} />
                <div className="mt-2 flex justify-between text-[11px] text-zinc-600">
                  <span className="tabular-nums">
                    {formatBytes(u.bytesUploaded)} of {formatBytes(u.size)}
                  </span>
                  {u.state === 'uploading' && (
                    <span className="tabular-nums">
                      {formatSpeed(u.speedBps)} · {formatEta(u.etaSeconds)} left
                    </span>
                  )}
                </div>
              </div>
            ))}
            {queuedHere > 0 && (
              <p className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-[12px] text-zinc-500 tabular-nums">
                {queuedHere} more file{queuedHere === 1 ? '' : 's'} queued — uploading one at a time. Track everything in Transfers.
              </p>
            )}
          </div>
        )}

        {/* folders — project root only */}
        {!currentFolder && (
          <section>
            <div className="mb-2.5 flex h-7 items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-600">Folders</h2>
              <button
                onClick={() => setCreatingFolder(true)}
                className="text-[12px] font-medium text-zinc-400 transition-colors hover:text-zinc-100"
              >
                New folder
              </button>
            </div>
            {folders.length === 0 ? (
              <p className="rounded-xl border border-dashed border-white/[0.08] px-4 py-3.5 text-[12px] text-zinc-600">
                No folders yet — organize by day or camera, e.g. “Day 1”, “Drone”.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                {folders.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center rounded-xl border border-white/[0.08] bg-white/[0.03] transition-colors hover:bg-white/[0.05]"
                  >
                    <button onClick={() => setSearch({ f: f.id })} className="flex min-w-0 flex-1 items-center gap-2.5 p-3 text-left">
                      <span className="text-zinc-500">
                        <IconFolder size={18} />
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                          <span className="truncate">{f.name}</span>
                          {f.restricted && <IconLock size={11} className="shrink-0 text-amber-400/80" />}
                        </span>
                        <span className="block truncate text-[11px] text-zinc-600">
                          {f.videoCount} file{f.videoCount === 1 ? '' : 's'}
                          {f.createdByUsername ? ` · by ${f.createdByUsername}` : ''}
                        </span>
                      </span>
                    </button>
                    {isAdmin && (
                      <button
                        onClick={() => setFolderMenu(f)}
                        className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-600 hover:bg-white/[0.06] hover:text-zinc-300"
                        aria-label={`Options for ${f.name}`}
                      >
                        <IconMore size={16} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* videos */}
        <section>
          <div className="mb-2.5 flex h-7 items-center justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
              {selectMode ? `${selected.size} selected` : currentFolder ? 'Files' : 'Files in project root'}
            </h2>
            <div className="flex items-center gap-2.5">
              {!selectMode && (videos?.length ?? 0) > 0 && (
                <div className="flex rounded-md border border-white/10 bg-black/30 p-0.5">
                  <button
                    onClick={() => setViewMode('list')}
                    aria-label="List view"
                    className={`flex h-6 w-7 items-center justify-center rounded transition-colors ${viewMode === 'list' ? 'bg-white/10 text-zinc-200' : 'text-zinc-600 hover:text-zinc-400'}`}
                  >
                    <IconList size={13} />
                  </button>
                  <button
                    onClick={() => setViewMode('grid')}
                    aria-label="Grid view"
                    className={`flex h-6 w-7 items-center justify-center rounded transition-colors ${viewMode === 'grid' ? 'bg-white/10 text-zinc-200' : 'text-zinc-600 hover:text-zinc-400'}`}
                  >
                    <IconGrid size={13} />
                  </button>
                </div>
              )}
              {selectMode ? (
                <>
                  <button
                    onClick={() => {
                      const selectableIds = filteredVideos.filter(isSelectable).map((v) => v.id);
                      const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
                      setSelected(allSelected ? new Set() : new Set(selectableIds));
                    }}
                    className="text-[12px] font-medium text-blue-400 transition-colors hover:text-blue-300"
                  >
                    {filteredVideos.filter(isSelectable).every((v) => selected.has(v.id)) && selected.size > 0
                      ? 'Deselect all'
                      : `Select all${typeFilter !== 'all' || statusFilter !== 'all' || q ? ' (filtered)' : ''}`}
                  </button>
                  <button onClick={exitSelect} className="text-[12px] font-medium text-zinc-400 transition-colors hover:text-zinc-100">
                    Cancel
                  </button>
                </>
              ) : (
                selectableCount > 0 && (
                  <button
                    onClick={() => setSelectMode(true)}
                    className="text-[12px] font-medium text-zinc-400 transition-colors hover:text-zinc-100"
                  >
                    Select
                  </button>
                )
              )}
            </div>
          </div>

          {videos === null && <Spinner />}
          {videos !== null && videos.length >= 4 && (
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                className="h-9 w-full rounded-lg border border-white/10 bg-black/30 px-3 text-[13px] text-zinc-100 placeholder-zinc-600 outline-none transition-colors focus:border-blue-500/60 sm:max-w-xs"
                placeholder="Search files…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="flex flex-1 gap-2">
                <select
                  className="h-9 flex-1 rounded-lg border border-white/10 bg-black/30 px-2 text-[12px] text-zinc-300 outline-none"
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
                >
                  <option value="all">All types</option>
                  <option value="video">Videos</option>
                  <option value="image">Photos</option>
                  <option value="other">Other files</option>
                </select>
                <select
                  className="h-9 flex-1 rounded-lg border border-white/10 bg-black/30 px-2 text-[12px] text-zinc-300 outline-none"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                >
                  <option value="all">All statuses</option>
                  <option value="READY">Ready</option>
                  <option value="UPLOADING">Pending upload</option>
                </select>
                <select
                  className="h-9 flex-1 rounded-lg border border-white/10 bg-black/30 px-2 text-[12px] text-zinc-300 outline-none"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="largest">Largest first</option>
                  <option value="name">By name</option>
                </select>
              </div>
              {(q || statusFilter !== 'all' || typeFilter !== 'all') && (
                <p className="text-[11px] text-zinc-600 tabular-nums">
                  {filteredVideos.length} of {videos.length} videos
                </p>
              )}
            </div>
          )}
          <div className={viewMode === 'grid' ? 'grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6' : 'space-y-2'}>
            {videos && (
              <LazyList
                items={filteredVideos}
                keyFor={(v) => v.id}
                estimateHeight={viewMode === 'grid' ? 120 : 74}
                limit={limit}
                onLimitChange={setLimit}
                renderItem={(v) =>
                  viewMode === 'grid' ? (
                    <GridTile
                      v={v}
                      thumb={thumbs[v.id]}
                      selectMode={selectMode}
                      isSelected={selected.has(v.id)}
                      selectable={isSelectable(v)}
                      onToggle={onRowToggle}
                      onMenu={setVideoMenu}
                      onPlay={onRowPlay}
                    />
                  ) : (
                    <VideoRow
                      v={v}
                      selectMode={selectMode}
                      isSelected={selected.has(v.id)}
                      selectable={isSelectable(v)}
                      onToggle={onRowToggle}
                      onMenu={setVideoMenu}
                      onPlay={onRowPlay}
                    />
                  )
                }
              />
            )}
          </div>
          {videos?.length === 0 && localUploads.length === 0 && (
            <EmptyState icon={<IconFilm size={30} />} title="Nothing here yet" sub="Add videos, photos, or any file — originals, untouched." />
          )}
        </section>
      </div>

      {viewerIndex >= 0 && (
        <Lightbox
          items={viewable}
          index={viewerIndex}
          onIndex={(i) => setViewerId(viewable[i]?.id ?? null)}
          onClose={() => setViewerId(null)}
          previewHint={previews}
          onError={setNotice}
          onToast={showToast}
        />
      )}

      {/* selection action bar / upload button */}
      {selectMode ? (
        <div className="fixed inset-x-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-30 border-t border-white/[0.06] bg-[#0e0e11]/95 backdrop-blur lg:bottom-0 lg:left-60">
          <div className="mx-auto flex max-w-lg gap-2 px-4 py-3 lg:max-w-2xl">
            <Button full kind="primary" disabled={readySelected === 0} onClick={() => void downloadSelected()}>
              <IconDownload size={16} /> Download{readySelected > 0 ? ` (${readySelected})` : ''}
            </Button>
            <Button full disabled={!allModifiable} onClick={() => setMoving(selectedVideos)}>
              <IconFolderMove size={16} /> Move
            </Button>
            <Button full kind="danger" disabled={!allModifiable} onClick={() => setDeletingVideos(selectedVideos)}>
              <IconTrash size={16} />
            </Button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAddSheetOpen(true)}
          className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-30 flex h-12 items-center gap-2 rounded-full bg-blue-600 pl-4 pr-5 text-[14px] font-semibold text-white transition-colors hover:bg-blue-500 active:opacity-90 lg:bottom-8 lg:right-8"
        >
          <IconPlus size={18} /> Add
        </button>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void addFiles(e.target.files);
          e.target.value = '';
        }}
      />
      {/* capture= makes these open the camera directly; the recording goes
          straight into the upload queue. */}
      <input
        ref={recordInput}
        type="file"
        accept="video/*"
        capture="environment"
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void addFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={photoInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void addFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {/* --- add source sheet --- */}
      <Sheet open={addSheetOpen} onClose={() => setAddSheetOpen(false)} title="Add to this folder">
        <div className="space-y-0.5">
          <SheetAction
            icon={<IconFolder size={18} />}
            label="Choose files"
            sub="Videos, photos, any file — originals, untouched"
            onClick={() => {
              setAddSheetOpen(false);
              fileInput.current?.click();
            }}
          />
          <SheetAction
            icon={<IconPlay size={18} />}
            label="Record a video"
            sub="Opens the camera; uploads when you stop"
            onClick={() => {
              setAddSheetOpen(false);
              recordInput.current?.click();
            }}
          />
          <SheetAction
            icon={<IconImage size={18} />}
            label="Take a photo"
            onClick={() => {
              setAddSheetOpen(false);
              photoInput.current?.click();
            }}
          />
        </div>
      </Sheet>

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 lg:pl-[16.5rem]">
          <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-blue-500/70 bg-blue-500/[0.08] px-8 py-14 text-center">
            <IconDownload size={28} className="rotate-180 text-blue-400" />
            <p className="text-[15px] font-semibold text-zinc-100">
              Drop to upload to {currentFolder ? `“${currentFolder.name}”` : project?.name ?? 'this project'}
            </p>
            <p className="text-[12px] text-zinc-500">Files or whole folders — originals, resumable, duplicates skipped</p>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-4">
          <span className="rounded-lg border border-white/10 bg-[#18181b] px-4 py-2.5 text-[12px] font-medium text-zinc-200">{toast}</span>
        </div>
      )}

      {/* --- single video action sheet --- */}
      <Sheet open={videoMenu !== null} onClose={() => setVideoMenu(null)} title={videoMenu?.displayName}>
        {videoMenu && (
          <div className="space-y-0.5">
            <p className="mb-3 px-1 text-[12px] text-zinc-600 tabular-nums">
              {formatBytes(videoMenu.size)} · uploaded {formatDate(videoMenu.createdAt)} by {videoMenu.ownerUsername}
            </p>
            {videoMenu.status === 'READY' && (
              <>
                <SheetAction
                  icon={videoMenu.mimeType.startsWith('image/') ? <IconImage size={18} /> : <IconPlay size={18} />}
                  label={videoMenu.mimeType.startsWith('video/') ? 'Play' : 'View'}
                  sub="Opens the original — nothing is re-encoded"
                  onClick={() => {
                    setViewerId(videoMenu.id);
                    setVideoMenu(null);
                  }}
                />
                <SheetAction
                  icon={<IconDownload size={18} />}
                  label="Download original"
                  sub="Resumable — survives connection drops"
                  onClick={async () => {
                    const v = videoMenu;
                    setVideoMenu(null);
                    try {
                      const mode = await startVideoDownload(v);
                      if (mode === 'managed') showToast('Download started — track it in Transfers');
                      if (mode === 'native') showToast('Download handed to the browser');
                    } catch (err) {
                      setNotice(err instanceof Error ? err.message : 'Could not start download');
                    }
                  }}
                />
                <SheetAction
                  icon={<IconLink size={18} />}
                  label="Copy view link"
                  sub="Anyone with the link can watch for 1 hour"
                  onClick={async () => {
                    const v = videoMenu;
                    setVideoMenu(null);
                    try {
                      const { url } = await api.viewUrl(v.id);
                      await navigator.clipboard.writeText(url);
                      showToast('Link copied — valid for 1 hour');
                    } catch {
                      setNotice('Could not create the link');
                    }
                  }}
                />
              </>
            )}
            {canModify(videoMenu) && (
              <>
                <SheetAction
                  icon={<IconPencil size={18} />}
                  label="Rename"
                  onClick={() => {
                    setRenamingVideo(videoMenu);
                    setVideoMenu(null);
                  }}
                />
                <SheetAction
                  icon={<IconEyeOff size={18} />}
                  label={videoMenu.hidden ? 'Unhide' : 'Hide from members'}
                  sub={videoMenu.hidden ? 'Currently visible only to you and admins' : 'Only you and admins will see it'}
                  onClick={async () => {
                    const v = videoMenu;
                    setVideoMenu(null);
                    try {
                      await api.setVideoHidden(v.id, !v.hidden);
                      showToast(v.hidden ? 'Visible to everyone again' : 'Hidden from members');
                      refresh();
                    } catch (err) {
                      setNotice(err instanceof Error ? err.message : 'Could not change visibility');
                    }
                  }}
                />
                <SheetAction
                  icon={<IconFolderMove size={18} />}
                  label="Move to folder"
                  sub={currentFolder ? `Currently in ${currentFolder.name}` : 'Currently in project root'}
                  onClick={() => {
                    setMoving([videoMenu]);
                    setVideoMenu(null);
                  }}
                />
                <SheetAction
                  icon={<IconTrash size={18} />}
                  label="Delete"
                  sub="Removes the file from cloud storage"
                  danger
                  onClick={() => {
                    setDeletingVideos([videoMenu]);
                    setVideoMenu(null);
                  }}
                />
              </>
            )}
          </div>
        )}
      </Sheet>

      {/* --- move sheet (single or bulk) --- */}
      <Sheet
        open={moving !== null}
        onClose={() => setMoving(null)}
        title={moving?.length === 1 ? `Move “${moving[0]!.displayName}”` : `Move ${moving?.length ?? 0} videos`}
      >
        <div className="space-y-0.5">
          <SheetAction
            icon={<IconHome size={18} />}
            label="Project root"
            selected={moving?.every((v) => v.folderId === null)}
            onClick={() => void doMove(moving!, null, 'project root')}
          />
          {folders.map((f) => (
            <SheetAction
              key={f.id}
              icon={<IconFolder size={18} />}
              label={f.name}
              selected={moving?.every((v) => v.folderId === f.id)}
              onClick={() => void doMove(moving!, f.id, f.name)}
            />
          ))}
          {folders.length === 0 && (
            <p className="px-1 py-2 text-[13px] text-zinc-500">No folders in this project yet — create one first.</p>
          )}
        </div>
      </Sheet>

      {/* --- rename / delete (single or bulk) --- */}
      <InputSheet
        open={renamingVideo !== null}
        onClose={() => setRenamingVideo(null)}
        title="Rename video"
        initial={renamingVideo?.displayName ?? ''}
        submitLabel="Rename"
        onSubmit={async (name) => {
          await api.renameVideo(renamingVideo!.id, name);
          refresh();
        }}
      />
      <ConfirmSheet
        open={deletingVideos !== null}
        onClose={() => setDeletingVideos(null)}
        title={deletingVideos?.length === 1 ? `Delete “${deletingVideos[0]!.displayName}”?` : `Delete ${deletingVideos?.length ?? 0} videos?`}
        body={
          deletingVideos?.length === 1
            ? 'The original file is permanently removed from cloud storage. This cannot be undone.'
            : `${deletingVideos?.length ?? 0} original files are permanently removed from cloud storage. This cannot be undone.`
        }
        confirmLabel="Delete forever"
        onConfirm={async () => {
          for (const v of deletingVideos ?? []) {
            await api.deleteVideo(v.id);
          }
          exitSelect();
          refresh();
        }}
      />

      {/* --- folder sheets --- */}
      <InputSheet
        open={creatingFolder}
        onClose={() => setCreatingFolder(false)}
        title="New folder"
        placeholder="e.g. Day 1, Drone"
        submitLabel="Create folder"
        onSubmit={async (name) => {
          await api.createFolder(projectId, { name });
          refresh();
        }}
      />
      <Sheet open={folderMenu !== null} onClose={() => setFolderMenu(null)} title={folderMenu?.name}>
        <div className="space-y-0.5">
          <SheetAction
            icon={<IconPencil size={18} />}
            label="Rename"
            onClick={() => {
              setRenamingFolder(folderMenu);
              setFolderMenu(null);
            }}
          />
          <SheetAction
            icon={<IconLock size={18} />}
            label="Who can access"
            sub={folderMenu?.restricted ? 'Restricted to specific people' : 'Everyone can see this folder'}
            onClick={() => {
              setAccessFolder(folderMenu);
              setFolderMenu(null);
            }}
          />
          <SheetAction
            icon={<IconTrash size={18} />}
            label="Delete folder"
            sub={folderMenu && folderMenu.videoCount > 0 ? `Deletes ${folderMenu.videoCount} video(s) from storage` : 'Folder is empty'}
            danger
            onClick={() => {
              setDeletingFolder(folderMenu);
              setFolderMenu(null);
            }}
          />
        </div>
      </Sheet>
      <InputSheet
        open={renamingFolder !== null}
        onClose={() => setRenamingFolder(null)}
        title="Rename folder"
        initial={renamingFolder?.name ?? ''}
        submitLabel="Rename"
        onSubmit={async (name) => {
          await api.renameFolder(renamingFolder!.id, { name });
          refresh();
        }}
      />
      {accessFolder && (
        <FolderAccessSheet
          folder={accessFolder}
          onClose={() => setAccessFolder(null)}
          onSaved={() => {
            setAccessFolder(null);
            showToast('Folder access updated');
            refresh();
          }}
          onError={setNotice}
        />
      )}

      <ConfirmSheet
        open={deletingFolder !== null}
        onClose={() => setDeletingFolder(null)}
        title={`Delete “${deletingFolder?.name}”?`}
        body={
          deletingFolder && deletingFolder.videoCount > 0
            ? `This permanently deletes the folder and its ${deletingFolder.videoCount} video(s) from cloud storage. Tip: move the videos out first if you want to keep them.`
            : 'This deletes the empty folder.'
        }
        confirmLabel="Delete forever"
        onConfirm={async () => {
          await api.deleteFolder(deletingFolder!.id, (deletingFolder?.videoCount ?? 0) > 0);
          refresh();
        }}
      />
    </Layout>
  );
}

const VideoRow = memo(function VideoRow({
  v,
  selectMode,
  isSelected,
  selectable,
  onToggle,
  onMenu,
  onPlay,
}: {
  v: VideoInfo;
  selectMode: boolean;
  isSelected: boolean;
  selectable: boolean;
  onToggle: (v: VideoInfo) => void;
  onMenu: (v: VideoInfo) => void;
  onPlay: (v: VideoInfo) => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border p-3 transition-colors ${
        isSelected ? 'border-blue-500/50 bg-blue-500/[0.06]' : 'border-white/[0.08] bg-white/[0.03]'
      } ${selectMode && !selectable ? 'opacity-40' : ''}`}
    >
      {selectMode ? (
        <button
          onClick={() => selectable && onToggle(v)}
          disabled={!selectable}
          className="flex h-12 w-12 shrink-0 items-center justify-center"
          aria-label={isSelected ? `Deselect ${v.displayName}` : `Select ${v.displayName}`}
        >
          <span
            className={`flex h-[22px] w-[22px] items-center justify-center rounded-full border transition-colors ${
              isSelected ? 'border-blue-500 bg-blue-500 text-white' : 'border-white/25 text-transparent'
            }`}
          >
            <IconCheck size={13} />
          </span>
        </button>
      ) : (
        <button
          disabled={v.status !== 'READY'}
          onClick={() => onPlay(v)}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-zinc-300 transition-colors hover:bg-white/[0.08] disabled:opacity-40"
          aria-label={`Open ${v.displayName}`}
        >
          {v.mimeType.startsWith('image/') ? <IconImage size={16} /> : v.mimeType.startsWith('video/') ? <IconPlay size={16} /> : <IconFile size={16} />}
        </button>
      )}
      <button
        className="min-w-0 flex-1 text-left"
        onClick={() => (selectMode ? selectable && onToggle(v) : onMenu(v))}
        disabled={selectMode && !selectable}
      >
        <span className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-medium">{v.displayName}</span>
            {v.hidden && <IconEyeOff size={12} className="shrink-0 text-amber-400/80" />}
          </span>
          {!selectMode && <StatusChip state={v.status} />}
        </span>
        <span className="mt-0.5 block text-[12px] text-zinc-600 tabular-nums">
          {formatBytes(v.size)} · {formatDate(v.createdAt)} · {v.ownerUsername}
        </span>
      </button>
      {!selectMode && (
        <button
          onClick={() => onMenu(v)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-600 transition-colors hover:bg-white/[0.06] hover:text-zinc-300"
          aria-label={`Options for ${v.displayName}`}
        >
          <IconMore size={18} />
        </button>
      )}
    </div>
  );
});


/** Admin sheet: restrict a folder to specific accounts. */
function FolderAccessSheet({
  folder,
  onClose,
  onSaved,
  onError,
}: {
  folder: FolderInfo;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [users, setUsers] = useState<(UserInfo & { active: boolean })[] | null>(null);
  const [restricted, setRestricted] = useState(folder.restricted);
  const [members, setMembers] = useState<Set<string>>(new Set(folder.memberIds ?? []));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .listUsers()
      .then((r) => setUsers(r.users))
      .catch(() => onError('Could not load the user list'));
  }, [onError]);

  return (
    <Sheet open onClose={onClose} title={`Who can access “${folder.name}”`}>
      <div className="space-y-4">
        <div className="flex rounded-lg border border-white/10 bg-black/30 p-0.5">
          {[
            { v: false, label: 'Everyone' },
            { v: true, label: 'Specific people' },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => setRestricted(o.v)}
              className={`h-9 flex-1 rounded-[7px] text-[13px] font-medium transition-colors ${
                restricted === o.v ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="max-h-[40vh] space-y-1 overflow-y-auto">
            {users === null && <Spinner />}
            {users
              ?.filter((u) => u.role !== 'admin')
              .map((u) => {
                const on = members.has(u.id);
                return (
                  <button
                    key={u.id}
                    onClick={() =>
                      setMembers((prev) => {
                        const next = new Set(prev);
                        if (next.has(u.id)) next.delete(u.id);
                        else next.add(u.id);
                        return next;
                      })
                    }
                    className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left hover:bg-white/[0.06]"
                  >
                    <span
                      className={`flex h-[20px] w-[20px] items-center justify-center rounded-full border transition-colors ${
                        on ? 'border-blue-500 bg-blue-500 text-white' : 'border-white/25 text-transparent'
                      }`}
                    >
                      <IconCheck size={12} />
                    </span>
                    <span className="text-[14px] font-medium">{u.username}</span>
                    {u.scoped && <span className="rounded bg-white/[0.07] px-1.5 py-0.5 text-[10px] text-zinc-400">folder-only</span>}
                    {!u.active && <span className="text-[11px] text-red-400">deactivated</span>}
                  </button>
                );
              })}
            <p className="px-1 pt-1 text-[11px] text-zinc-600">
              Admins always have access. Folder-only accounts see this folder ONLY if ticked here — even when set to
              Everyone.
            </p>
          </div>
        <Button
          full
          kind="primary"
          size="lg"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.setFolderAccess(folder.id, restricted, restricted ? [...members] : []);
              onSaved();
            } catch (err) {
              onError(err instanceof Error ? err.message : 'Could not update access');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save access'}
        </Button>
      </div>
    </Sheet>
  );
}


/**
 * Fades a tile in once its bytes have decoded, over a shimmer placeholder, so a
 * grid fills in smoothly instead of flashing half-drawn images. `loaded` is
 * never reset when `src` changes: the URL flips from the original to the
 * generated thumbnail mid-scroll, and blanking an already-painted tile for that
 * swap would be worse than showing it a moment longer.
 */
function Thumb({ src, fallback }: { src: string; fallback: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  // A signed URL that expired while the grid sat open returns 403. Showing the
  // browser's broken-image glyph would be worse than the plain icon.
  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (failed) {
    return <span className="flex h-full w-full items-center justify-center text-zinc-600">{fallback}</span>;
  }
  return (
    <>
      {!loaded && <span className="absolute inset-0 animate-pulse bg-white/[0.06]" />}
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={`h-full w-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
      />
    </>
  );
}

const GridTile = memo(function GridTile({
  v,
  thumb,
  selectMode,
  isSelected,
  selectable,
  onToggle,
  onMenu,
  onPlay,
}: {
  v: VideoInfo;
  thumb?: string;
  selectMode: boolean;
  isSelected: boolean;
  selectable: boolean;
  onToggle: (v: VideoInfo) => void;
  onMenu: (v: VideoInfo) => void;
  onPlay: (v: VideoInfo) => void;
}) {
  const isImage = v.mimeType.startsWith('image/');
  const isVideo = v.mimeType.startsWith('video/');
  const icon = isImage ? <IconImage size={22} /> : isVideo ? <IconPlay size={22} /> : <IconFile size={22} />;
  return (
    <div
      className={`group relative aspect-square overflow-hidden rounded-lg border transition-colors ${
        isSelected ? 'border-blue-500' : 'border-white/[0.08]'
      } ${selectMode && !selectable ? 'opacity-40' : ''} bg-white/[0.03]`}
    >
      <button
        className="block h-full w-full"
        disabled={selectMode ? !selectable : v.status !== 'READY'}
        onClick={() => (selectMode ? onToggle(v) : v.status === 'READY' ? onPlay(v) : onMenu(v))}
        aria-label={v.displayName}
      >
        {thumb ? (
          <Thumb src={thumb} fallback={icon} />
        ) : (
          <span
            className={`flex h-full w-full items-center justify-center text-zinc-600 ${
              isImage && v.status === 'READY' ? 'animate-pulse' : ''
            }`}
          >
            {icon}
          </span>
        )}
        <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1.5 py-1 text-left text-[10px] text-zinc-300">
          {v.displayName}
        </span>
      </button>
      {v.status !== 'READY' && (
        <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-medium text-zinc-300">
          Pending
        </span>
      )}
      {v.hidden && !selectMode && (
        <span className="absolute left-1.5 top-1.5 text-amber-400/90">
          <IconEyeOff size={12} />
        </span>
      )}
      {selectMode ? (
        <span
          className={`pointer-events-none absolute right-1.5 top-1.5 flex h-[20px] w-[20px] items-center justify-center rounded-full border ${
            isSelected ? 'border-blue-500 bg-blue-500 text-white' : 'border-white/60 bg-black/40 text-transparent'
          }`}
        >
          <IconCheck size={12} />
        </span>
      ) : (
        <button
          onClick={() => onMenu(v)}
          className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-zinc-300 opacity-0 transition-opacity hover:text-white focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label={`Options for ${v.displayName}`}
        >
          <IconMore size={15} />
        </button>
      )}
    </div>
  );
});
