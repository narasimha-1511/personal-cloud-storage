import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FolderInfo, ProjectInfo, VideoInfo } from '@videovault/shared';
import { api } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import { Button, Card, StatusChip } from '../components/ui';
import { useAuth } from '../auth';

export default function BrowsePage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [folder, setFolder] = useState<FolderInfo | null>(null);
  const [videos, setVideos] = useState<VideoInfo[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const loadProjects = useCallback(() => {
    api.listProjects().then((r) => setProjects(r.projects)).catch(() => setNotice('Could not load projects'));
  }, []);
  useEffect(loadProjects, [loadProjects]);

  const loadContents = useCallback(() => {
    if (!project) return;
    api.listFolders(project.id).then((r) => setFolders(r.folders)).catch(() => {});
    api
      .listVideos({ projectId: project.id, folderId: folder ? folder.id : 'none' })
      .then((r) => setVideos(r.videos))
      .catch(() => setNotice('Could not load videos'));
  }, [project, folder]);
  useEffect(loadContents, [loadContents]);

  async function run(fn: () => Promise<unknown>, reload: () => void) {
    setNotice(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Operation failed');
    }
  }

  // ---- project list view ----
  if (!project) {
    return (
      <div className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Projects</h2>
        {notice && <Notice text={notice} />}
        {projects.map((p) => (
          <Card key={p.id}>
            <div className="flex items-center justify-between gap-2">
              <button className="min-w-0 flex-1 text-left" onClick={() => setProject(p)}>
                <p className="truncate font-medium">{p.name}</p>
                <p className="text-xs text-slate-500">
                  {p.videoCount} video{p.videoCount === 1 ? '' : 's'} · {p.folderCount} folder{p.folderCount === 1 ? '' : 's'} · {formatDate(p.createdAt)}
                </p>
              </button>
              {isAdmin && (
                <div className="flex shrink-0 gap-1">
                  <Button
                    kind="ghost"
                    onClick={() => {
                      const name = prompt('Rename project:', p.name)?.trim();
                      if (name) void run(() => api.renameProject(p.id, { name }), loadProjects);
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    kind="ghost"
                    onClick={() => {
                      if (p.videoCount > 0) {
                        if (!confirm(`Delete "${p.name}" AND its ${p.videoCount} video(s) permanently from storage?`)) return;
                        void run(() => api.deleteProject(p.id, true), loadProjects);
                      } else if (confirm(`Delete empty project "${p.name}"?`)) {
                        void run(() => api.deleteProject(p.id), loadProjects);
                      }
                    }}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </div>
          </Card>
        ))}
        {projects.length === 0 && <p className="text-sm text-slate-500">No projects yet{isAdmin ? ' — create one from the Upload tab.' : '.'}</p>}
      </div>
    );
  }

  // ---- inside a project ----
  return (
    <div className="space-y-4">
      <nav className="flex items-center gap-1 text-sm text-slate-400">
        <button className="hover:text-slate-200" onClick={() => { setFolder(null); setProject(null); }}>
          Projects
        </button>
        <span>/</span>
        <button className={folder ? 'hover:text-slate-200' : 'text-slate-200'} onClick={() => setFolder(null)}>
          {project.name}
        </button>
        {folder && (
          <>
            <span>/</span>
            <span className="text-slate-200">{folder.name}</span>
          </>
        )}
      </nav>
      {notice && <Notice text={notice} />}

      {!folder && folders.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Folders</h3>
          {folders.map((f) => (
            <div key={f.id} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900 px-3 py-2">
              <button className="min-w-0 flex-1 text-left" onClick={() => setFolder(f)}>
                <span className="text-sm">📁 {f.name}</span>
                <span className="ml-2 text-xs text-slate-500">{f.videoCount} video{f.videoCount === 1 ? '' : 's'}</span>
              </button>
              {isAdmin && (
                <div className="flex shrink-0 gap-1">
                  <Button
                    kind="ghost"
                    onClick={() => {
                      const name = prompt('Rename folder:', f.name)?.trim();
                      if (name) void run(() => api.renameFolder(f.id, { name }), loadContents);
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    kind="ghost"
                    onClick={() => {
                      if (f.videoCount > 0) {
                        if (!confirm(`Delete "${f.name}" AND its ${f.videoCount} video(s) permanently?`)) return;
                        void run(() => api.deleteFolder(f.id, true), loadContents);
                      } else if (confirm(`Delete empty folder "${f.name}"?`)) {
                        void run(() => api.deleteFolder(f.id), loadContents);
                      }
                    }}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Videos {folder ? `in ${folder.name}` : 'in project root'}
        </h3>
        {videos.map((v) => (
          <VideoRow key={v.id} v={v} folders={folders} canModify={isAdmin || v.ownerId === user?.id} onChanged={loadContents} onError={setNotice} />
        ))}
        {videos.length === 0 && <p className="text-sm text-slate-500">No videos here.</p>}
      </section>
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return <p className="rounded-lg border border-amber-800 bg-amber-950 px-3 py-2 text-sm text-amber-200">{text}</p>;
}

function VideoRow({
  v,
  folders,
  canModify,
  onChanged,
  onError,
}: {
  v: VideoInfo;
  folders: FolderInfo[];
  canModify: boolean;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Operation failed');
    }
  }

  async function copyLink() {
    try {
      const { url } = await api.viewUrl(v.id);
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not create link');
    }
  }

  return (
    <Card>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-medium">{v.displayName}</p>
          <StatusChip state={v.status} />
        </div>
        <p className="text-xs text-slate-500">
          {formatBytes(v.size)} · {v.mimeType} · {formatDate(v.createdAt)} · by {v.ownerUsername}
        </p>
        <div className="flex flex-wrap gap-2">
          {v.status === 'READY' && (
            <>
              <Link to={`/watch/${v.id}`} className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500">
                Play
              </Link>
              <Button onClick={() => void copyLink()}>{copied ? 'Link copied ✓' : 'Copy view link (1h)'}</Button>
            </>
          )}
          {canModify && (
            <>
              <Button
                kind="ghost"
                onClick={() => {
                  const name = prompt('Rename video:', v.displayName)?.trim();
                  if (name) void act(() => api.renameVideo(v.id, name));
                }}
              >
                Rename
              </Button>
              {folders.length > 0 && (
                <Button
                  kind="ghost"
                  onClick={() => {
                    const options = ['(project root)', ...folders.map((f) => f.name)].map((n, i) => `${i}: ${n}`).join('\n');
                    const pick = prompt(`Move to folder — enter a number:\n${options}`);
                    if (pick === null) return;
                    const idx = Number(pick);
                    if (!Number.isInteger(idx) || idx < 0 || idx > folders.length) return;
                    const folderId = idx === 0 ? null : folders[idx - 1]!.id;
                    void act(() => api.moveVideo(v.id, { folderId }));
                  }}
                >
                  Move
                </Button>
              )}
              <Button
                kind="danger"
                onClick={() => {
                  if (confirm(`Delete "${v.displayName}" permanently from storage? This cannot be undone.`)) {
                    void act(() => api.deleteVideo(v.id));
                  }
                }}
              >
                Delete
              </Button>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
