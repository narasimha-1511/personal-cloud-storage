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
  IconFilm,
  IconFolder,
  IconFolderMove,
  IconHome,
  IconLink,
  IconMore,
  IconPencil,
  IconPlay,
  IconPlus,
  IconTrash,
} from '../components/icons';

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
  const [moving, setMoving] = useState<VideoInfo[] | null>(null);
  const [renamingVideo, setRenamingVideo] = useState<VideoInfo | null>(null);
  const [deletingVideos, setDeletingVideos] = useState<VideoInfo[] | null>(null);
  const [folderMenu, setFolderMenu] = useState<FolderInfo | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<FolderInfo | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<FolderInfo | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);

  // multi-select
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fileInput = useRef<HTMLInputElement>(null);
  const uploads = useUploads();
  const startedHere = useRef(new Map<string, string>());
  const localUploads = uploads.filter(
    (u) => ACTIVE_STATES.includes(u.state) && startedHere.current.get(u.localId) === `${projectId}:${folderId ?? ''}`,
  );

  const currentFolder = folders.find((f) => f.id === folderId) ?? null;
  const canModify = useCallback((v: VideoInfo) => isAdmin || v.ownerId === user?.id, [isAdmin, user?.id]);

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
    setSelectMode(false);
    setSelected(new Set());
    load();
  }, [load]);

  // Refresh when an upload completes so the new video flips to Ready.
  const doneCount = uploads.filter((u) => u.state === 'done').length;
  const prevDone = useRef(doneCount);
  useEffect(() => {
    if (doneCount > prevDone.current) load();
    prevDone.current = doneCount;
  }, [doneCount, load]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  async function addFiles(files: FileList) {
    setNotice(null);
    try {
      // One batched request registers the whole selection at once.
      const localIds = await uploadManager.addFiles(
        Array.from(files).map((file) => ({ file })),
        { projectId, folderId },
      );
      for (const localId of localIds) {
        startedHere.current.set(localId, `${projectId}:${folderId ?? ''}`);
      }
      showToast(`${localIds.length} upload${localIds.length === 1 ? '' : 's'} queued`);
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not start uploads');
    }
  }

  function toggleSelect(v: VideoInfo) {
    if (!canModify(v)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(v.id)) next.delete(v.id);
      else next.add(v.id);
      return next;
    });
  }

  function exitSelect() {
    setSelectMode(false);
    setSelected(new Set());
  }

  const selectedVideos = (videos ?? []).filter((v) => selected.has(v.id));
  const selectableCount = (videos ?? []).filter(canModify).length;

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
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Move failed');
      load();
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
        {localUploads.length > 0 && (
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
              <div className="grid grid-cols-2 gap-2">
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
                        <span className="block truncate text-[13px] font-medium">{f.name}</span>
                        <span className="block text-[11px] text-zinc-600">
                          {f.videoCount} video{f.videoCount === 1 ? '' : 's'}
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
              {selectMode ? `${selected.size} selected` : currentFolder ? 'Videos' : 'Videos in project root'}
            </h2>
            {selectMode ? (
              <button onClick={exitSelect} className="text-[12px] font-medium text-zinc-400 transition-colors hover:text-zinc-100">
                Cancel
              </button>
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

          {videos === null && <Spinner />}
          <div className="space-y-2">
            {videos?.map((v) => {
              const selectable = canModify(v);
              const isSelected = selected.has(v.id);
              return (
                <div
                  key={v.id}
                  className={`flex items-center gap-3 rounded-xl border p-3 transition-colors ${
                    isSelected ? 'border-blue-500/50 bg-blue-500/[0.06]' : 'border-white/[0.08] bg-white/[0.03]'
                  } ${selectMode && !selectable ? 'opacity-40' : ''}`}
                >
                  {selectMode ? (
                    <button
                      onClick={() => toggleSelect(v)}
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
                      onClick={() => navigate(`/watch/${v.id}`)}
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-zinc-300 transition-colors hover:bg-white/[0.08] disabled:opacity-40"
                      aria-label={`Play ${v.displayName}`}
                    >
                      <IconPlay size={16} />
                    </button>
                  )}
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => (selectMode ? toggleSelect(v) : setVideoMenu(v))}
                    disabled={selectMode && !selectable}
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span className="truncate text-[14px] font-medium">{v.displayName}</span>
                      {!selectMode && <StatusChip state={v.status} />}
                    </span>
                    <span className="mt-0.5 block text-[12px] text-zinc-600 tabular-nums">
                      {formatBytes(v.size)} · {formatDate(v.createdAt)} · {v.ownerUsername}
                    </span>
                  </button>
                  {!selectMode && (
                    <button
                      onClick={() => setVideoMenu(v)}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-600 transition-colors hover:bg-white/[0.06] hover:text-zinc-300"
                      aria-label={`Options for ${v.displayName}`}
                    >
                      <IconMore size={18} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {videos?.length === 0 && localUploads.length === 0 && (
            <EmptyState icon={<IconFilm size={30} />} title="Nothing here yet" sub="Add videos to upload originals in full quality." />
          )}
        </section>
      </div>

      {/* selection action bar / upload button */}
      {selectMode ? (
        <div className="fixed inset-x-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-30 border-t border-white/[0.06] bg-[#0e0e11]/95 backdrop-blur">
          <div className="mx-auto flex max-w-lg gap-2.5 px-4 py-3">
            <Button full disabled={selected.size === 0} onClick={() => setMoving(selectedVideos)}>
              <IconFolderMove size={16} /> Move
            </Button>
            <Button full kind="danger" disabled={selected.size === 0} onClick={() => setDeletingVideos(selectedVideos)}>
              <IconTrash size={16} /> Delete{selected.size > 0 ? ` (${selected.size})` : ''}
            </Button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => fileInput.current?.click()}
          className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-30 flex h-12 items-center gap-2 rounded-full bg-blue-600 pl-4 pr-5 text-[14px] font-semibold text-white transition-colors hover:bg-blue-500 active:opacity-90"
        >
          <IconPlus size={18} /> Add videos
        </button>
      )}
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
                  icon={<IconPlay size={18} />}
                  label="Play"
                  sub="Streams the original — nothing is re-encoded"
                  onClick={() => navigate(`/watch/${videoMenu.id}`)}
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
          load();
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
