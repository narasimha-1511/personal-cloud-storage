import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { FolderInfo, ProjectInfo, VideoInfo } from '@videovault/shared';
import { api } from '../lib/api';
import { ensureManagersInit, uploadManager, useUploads } from '../lib/managers';
import { startVideoDownload } from '../lib/startDownload';
import { formatBytes, formatDate, formatEta, formatSpeed, percent } from '../lib/format';
import { useAuth } from '../auth';
import Layout from '../components/Layout';
import {
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

const ACTIVE_STATES = ['queued', 'uploading', 'completing', 'waiting_network', 'paused', 'needs_file'];

export default function ProjectPage() {
  const { projectId = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const folderId = search.get('f');
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [videos, setVideos] = useState<VideoInfo[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [videoMenu, setVideoMenu] = useState<VideoInfo | null>(null);
  const [moving, setMoving] = useState<VideoInfo | null>(null);
  const [renamingVideo, setRenamingVideo] = useState<VideoInfo | null>(null);
  const [deletingVideo, setDeletingVideo] = useState<VideoInfo | null>(null);
  const [folderMenu, setFolderMenu] = useState<FolderInfo | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<FolderInfo | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<FolderInfo | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const uploads = useUploads();
  const localUploads = uploads.filter(
    (u) => ACTIVE_STATES.includes(u.state) && u.localId && uploadTarget(u.localId) === `${projectId}:${folderId ?? ''}`,
  );

  // uploadManager views don't carry project/folder, so track what we started here.
  const startedHere = useRef(new Map<string, string>());
  function uploadTarget(localId: string): string | undefined {
    return startedHere.current.get(localId);
  }

  const currentFolder = folders.find((f) => f.id === folderId) ?? null;

  const load = useCallback(() => {
    api
      .listProjects()
      .then((r) => setProject(r.projects.find((p) => p.id === projectId) ?? null))
      .catch(() => setNotice('Could not load — check your connection.'));
    api.listFolders(projectId).then((r) => setFolders(r.folders)).catch(() => {});
    api
      .listVideos({ projectId, folderId: folderId ?? 'none' })
      .then((r) => setVideos(r.videos))
      .catch(() => setNotice('Could not load videos — check your connection.'));
  }, [projectId, folderId]);

  useEffect(() => {
    void ensureManagersInit();
    setVideos(null);
    load();
  }, [load]);

  // Refresh the list when an upload finishes so the new video appears as READY.
  const doneCount = uploads.filter((u) => u.state === 'done').length;
  const prevDone = useRef(doneCount);
  useEffect(() => {
    if (doneCount > prevDone.current) load();
    prevDone.current = doneCount;
  }, [doneCount, load]);

  async function addFiles(files: FileList) {
    setNotice(null);
    let started = 0;
    for (const file of Array.from(files)) {
      try {
        const localId = await uploadManager.addFile(file, { projectId, folderId });
        startedHere.current.set(localId, `${projectId}:${folderId ?? ''}`);
        started++;
      } catch (err) {
        setNotice(`${file.name}: ${err instanceof Error ? err.message : 'could not start upload'}`);
      }
    }
    if (started > 0) {
      setToast(`${started} upload${started === 1 ? '' : 's'} started`);
      setTimeout(() => setToast(null), 3000);
      load();
    }
  }

  async function copyLink(v: VideoInfo) {
    const { url } = await api.viewUrl(v.id);
    await navigator.clipboard.writeText(url);
    setToast('Link copied — valid for 1 hour');
    setTimeout(() => setToast(null), 3000);
  }

  const canModify = (v: VideoInfo) => isAdmin || v.ownerId === user?.id;
  const title = currentFolder ? currentFolder.name : (project?.name ?? '…');
  const backTo = currentFolder ? `/p/${projectId}` : '/';

  return (
    <Layout title={title} back={backTo}>
      <div className="space-y-5">
        {notice && <Notice text={notice} onDismiss={() => setNotice(null)} />}

        {/* location breadcrumb when inside a folder */}
        {currentFolder && (
          <p className="-mt-1 text-xs text-slate-500">
            {project?.name} <span className="mx-1 text-slate-700">/</span> {currentFolder.name}
          </p>
        )}

        {/* uploads running for THIS location */}
        {localUploads.length > 0 && (
          <div className="space-y-2">
            {localUploads.map((u) => (
              <div key={u.localId} className="rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-semibold">{u.filename}</p>
                  <StatusChip state={u.state} />
                </div>
                <ProgressBar value={percent(u.bytesUploaded, u.size)} />
                <div className="mt-2 flex justify-between text-[11px] text-slate-500">
                  <span className="tabular-nums">
                    {formatBytes(u.bytesUploaded)} / {formatBytes(u.size)}
                  </span>
                  {u.state === 'uploading' && (
                    <span className="tabular-nums">
                      {formatSpeed(u.speedBps)} · {formatEta(u.etaSeconds)} left
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* folders — shown at project root only */}
        {!currentFolder && (folders.length > 0 || videos !== null) && (
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Folders</h2>
              <button onClick={() => setCreatingFolder(true)} className="text-xs font-semibold text-sky-400 hover:text-sky-300">
                + New folder
              </button>
            </div>
            {folders.length === 0 ? (
              <p className="rounded-xl border border-dashed border-white/10 px-4 py-3 text-xs text-slate-600">
                No folders — organize by day or camera, e.g. “Day 1”, “Drone”.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {folders.map((f) => (
                  <div key={f.id} className="relative">
                    <button
                      onClick={() => setSearch({ f: f.id })}
                      className="block w-full rounded-2xl border border-white/8 bg-white/[0.04] p-4 text-left transition-colors hover:bg-white/[0.07] active:scale-[0.98]"
                    >
                      <span className="text-xl">📁</span>
                      <p className="mt-1.5 truncate pr-6 text-sm font-semibold">{f.name}</p>
                      <p className="text-[11px] text-slate-500">
                        {f.videoCount} video{f.videoCount === 1 ? '' : 's'}
                      </p>
                    </button>
                    {isAdmin && (
                      <button
                        onClick={() => setFolderMenu(f)}
                        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full text-slate-500 hover:bg-white/10 hover:text-slate-200"
                        aria-label={`Options for ${f.name}`}
                      >
                        ⋯
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
          <h2 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-slate-500">
            {currentFolder ? 'Videos' : 'Videos in project root'}
          </h2>
          {videos === null && <Spinner />}
          <div className="space-y-2">
            {videos?.map((v) => (
              <div key={v.id} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.04] p-3">
                <button
                  disabled={v.status !== 'READY'}
                  onClick={() => navigate(`/watch/${v.id}`)}
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-slate-700/60 to-slate-800/60 text-xl transition-transform active:scale-95 disabled:opacity-50"
                  aria-label={`Play ${v.displayName}`}
                >
                  {v.status === 'READY' ? '▶' : '⏳'}
                </button>
                <button className="min-w-0 flex-1 text-left" onClick={() => setVideoMenu(v)}>
                  <p className="truncate text-sm font-semibold">{v.displayName}</p>
                  <p className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
                    {formatBytes(v.size)} · {formatDate(v.createdAt)} · {v.ownerUsername}
                  </p>
                  <div className="mt-1.5">
                    <StatusChip state={v.status} />
                  </div>
                </button>
                <button
                  onClick={() => setVideoMenu(v)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg text-slate-500 hover:bg-white/10 hover:text-slate-200"
                  aria-label={`Options for ${v.displayName}`}
                >
                  ⋯
                </button>
              </div>
            ))}
          </div>
          {videos?.length === 0 && localUploads.length === 0 && (
            <EmptyState icon="🎬" title="Nothing here yet" sub="Tap Add videos to upload originals in full quality." />
          )}
        </section>
      </div>

      {/* upload FAB */}
      <button
        onClick={() => fileInput.current?.click()}
        className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-30 flex items-center gap-2 rounded-full bg-sky-500 py-3.5 pl-4 pr-5 text-sm font-bold text-white shadow-xl shadow-sky-500/40 transition-all hover:bg-sky-400 active:scale-95"
      >
        <span className="text-lg leading-none">+</span> Add videos
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="video/*,.mp4,.mov,.mts,.mxf,.braw,.r3d"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void addFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {/* toast */}
      {toast && (
        <div className="fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-4">
          <span className="rounded-full border border-white/10 bg-[#0d1424] px-4 py-2 text-xs font-semibold text-slate-200 shadow-xl">
            {toast}
          </span>
        </div>
      )}

      {/* --- video action sheet --- */}
      <Sheet open={videoMenu !== null} onClose={() => setVideoMenu(null)} title={videoMenu?.displayName}>
        {videoMenu && (
          <div className="space-y-1">
            <p className="mb-3 px-1 text-xs text-slate-500 tabular-nums">
              {formatBytes(videoMenu.size)} · uploaded {formatDate(videoMenu.createdAt)} by {videoMenu.ownerUsername}
            </p>
            {videoMenu.status === 'READY' && (
              <>
                <SheetAction
                  icon="▶"
                  label="Play"
                  sub="Streams the original — nothing is re-encoded"
                  onClick={() => navigate(`/watch/${videoMenu.id}`)}
                />
                <SheetAction
                  icon="⬇"
                  label="Download original"
                  sub="Resumable — survives connection drops"
                  onClick={async () => {
                    const v = videoMenu;
                    setVideoMenu(null);
                    try {
                      const mode = await startVideoDownload(v);
                      if (mode === 'managed') setToast('Download started — track it in Transfers');
                      if (mode === 'native') setToast('Download handed to the browser');
                      setTimeout(() => setToast(null), 3000);
                    } catch (err) {
                      setNotice(err instanceof Error ? err.message : 'Could not start download');
                    }
                  }}
                />
                <SheetAction
                  icon="🔗"
                  label="Copy view link"
                  sub="Anyone with the link can watch for 1 hour"
                  onClick={async () => {
                    const v = videoMenu;
                    setVideoMenu(null);
                    try {
                      await copyLink(v);
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
                  icon="✏️"
                  label="Rename"
                  onClick={() => {
                    setRenamingVideo(videoMenu);
                    setVideoMenu(null);
                  }}
                />
                <SheetAction
                  icon="📂"
                  label="Move to folder…"
                  sub={currentFolder ? `Currently in ${currentFolder.name}` : 'Currently in project root'}
                  onClick={() => {
                    setMoving(videoMenu);
                    setVideoMenu(null);
                  }}
                />
                <SheetAction
                  icon="🗑"
                  label="Delete"
                  sub="Removes the file from cloud storage"
                  danger
                  onClick={() => {
                    setDeletingVideo(videoMenu);
                    setVideoMenu(null);
                  }}
                />
              </>
            )}
          </div>
        )}
      </Sheet>

      {/* --- move sheet --- */}
      <Sheet open={moving !== null} onClose={() => setMoving(null)} title={`Move “${moving?.displayName}”`}>
        <div className="space-y-1">
          <SheetAction
            icon="🏠"
            label="Project root"
            selected={moving?.folderId === null}
            onClick={async () => {
              const v = moving!;
              setMoving(null);
              if (v.folderId === null) return;
              try {
                await api.moveVideo(v.id, { folderId: null });
                setToast('Moved to project root');
                setTimeout(() => setToast(null), 3000);
                load();
              } catch (err) {
                setNotice(err instanceof Error ? err.message : 'Move failed');
              }
            }}
          />
          {folders.map((f) => (
            <SheetAction
              key={f.id}
              icon="📁"
              label={f.name}
              selected={moving?.folderId === f.id}
              onClick={async () => {
                const v = moving!;
                setMoving(null);
                if (v.folderId === f.id) return;
                try {
                  await api.moveVideo(v.id, { folderId: f.id });
                  setToast(`Moved to ${f.name}`);
                  setTimeout(() => setToast(null), 3000);
                  load();
                } catch (err) {
                  setNotice(err instanceof Error ? err.message : 'Move failed');
                }
              }}
            />
          ))}
          {folders.length === 0 && <p className="px-1 py-2 text-sm text-slate-500">No folders in this project yet — create one first.</p>}
        </div>
      </Sheet>

      {/* --- rename / delete video --- */}
      <InputSheet
        open={renamingVideo !== null}
        onClose={() => setRenamingVideo(null)}
        title="Rename video"
        initial={renamingVideo?.displayName ?? ''}
        submitLabel="Rename"
        onSubmit={async (name) => {
          await api.renameVideo(renamingVideo!.id, name);
          load();
        }}
      />
      <ConfirmSheet
        open={deletingVideo !== null}
        onClose={() => setDeletingVideo(null)}
        title={`Delete “${deletingVideo?.displayName}”?`}
        body="The original file is permanently removed from cloud storage. This cannot be undone."
        confirmLabel="Delete forever"
        onConfirm={async () => {
          await api.deleteVideo(deletingVideo!.id);
          load();
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
          load();
        }}
      />
      <Sheet open={folderMenu !== null} onClose={() => setFolderMenu(null)} title={folderMenu?.name}>
        <div className="space-y-1">
          <SheetAction
            icon="✏️"
            label="Rename"
            onClick={() => {
              setRenamingFolder(folderMenu);
              setFolderMenu(null);
            }}
          />
          <SheetAction
            icon="🗑"
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
          load();
        }}
      />
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
          load();
        }}
      />
    </Layout>
  );
}
