import { useEffect, useRef, useState } from 'react';
import type { FolderInfo, ProjectInfo } from '@videovault/shared';
import { api } from '../lib/api';
import { ensureManagersInit, uploadManager, useUploads } from '../lib/managers';
import { formatBytes, formatEta, formatSpeed, percent } from '../lib/format';
import type { UploadView } from '../lib/uploadManager';
import { Button, Card, Field, ProgressBar, StatusChip, inputClass } from '../components/ui';
import { useAuth } from '../auth';

export default function UploaderPage() {
  const { user } = useAuth();
  const uploads = useUploads();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [projectId, setProjectId] = useState('');
  const [folderId, setFolderId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const resumeInputRef = useRef<HTMLInputElement>(null);
  const resumeTargetRef = useRef<string | null>(null);

  useEffect(() => {
    void ensureManagersInit();
    api.listProjects().then((r) => {
      setProjects(r.projects);
      if (r.projects.length > 0 && !projectId) setProjectId(r.projects[0]!.id);
    }).catch(() => setNotice('Could not load projects — are you online?'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setFolderId('');
    if (!projectId) return;
    api.listFolders(projectId).then((r) => setFolders(r.folders)).catch(() => setFolders([]));
  }, [projectId]);

  async function addFiles(files: FileList | File[]) {
    if (!projectId) {
      setNotice('Pick a project first.');
      return;
    }
    setNotice(null);
    for (const file of Array.from(files)) {
      try {
        await uploadManager.addFile(file, { projectId, folderId: folderId || null });
      } catch (err) {
        setNotice(`${file.name}: ${err instanceof Error ? err.message : 'failed to start'}`);
      }
    }
  }

  async function onResumePick(files: FileList) {
    const localId = resumeTargetRef.current;
    resumeTargetRef.current = null;
    const pending = uploads.filter((u) => u.state === 'needs_file');
    setNotice(null);
    for (const file of Array.from(files)) {
      // Match the picked file to a pending upload by exact identity.
      const target =
        (localId ? pending.filter((u) => u.localId === localId) : pending).find(
          (u) => u.filename === file.name && u.size === file.size,
        ) ?? pending.find((u) => u.filename === file.name && u.size === file.size);
      if (!target) {
        setNotice(`"${file.name}" does not match any interrupted upload (name and size must be identical).`);
        continue;
      }
      try {
        await uploadManager.provideFile(target.localId, file);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Could not resume');
      }
    }
  }

  async function newFolder() {
    const name = prompt('Folder name (e.g. Day 1, Drone):')?.trim();
    if (!name || !projectId) return;
    try {
      const r = await api.createFolder(projectId, { name });
      setFolders((f) => [...f, r.folder]);
      setFolderId(r.folder.id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not create folder');
    }
  }

  async function newProject() {
    const name = prompt('Project name (e.g. Himachal 2026):')?.trim();
    if (!name) return;
    try {
      const r = await api.createProject({ name });
      setProjects((p) => [...p, r.project]);
      setProjectId(r.project.id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not create project');
    }
  }

  const activeStates = ['queued', 'uploading', 'completing', 'waiting_network', 'paused', 'needs_file', 'error'];
  const active = uploads.filter((u) => activeStates.includes(u.state));
  const finished = uploads.filter((u) => u.state === 'done' || u.state === 'aborted');

  return (
    <div className="space-y-4">
      <Card>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Project">
              <select className={inputClass} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.length === 0 && <option value="">No projects yet</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Folder">
              <select className={inputClass} value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                <option value="">(project root)</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="flex gap-2 text-sm">
            <button className="text-sky-400 hover:underline" onClick={() => void newFolder()}>
              + New folder
            </button>
            {user?.role === 'admin' && (
              <button className="text-sky-400 hover:underline" onClick={() => void newProject()}>
                + New project
              </button>
            )}
          </div>
          <Button kind="primary" full onClick={() => addInputRef.current?.click()} disabled={!projectId}>
            + ADD VIDEOS
          </Button>
          <input
            ref={addInputRef}
            type="file"
            accept="video/*,.mp4,.mov,.mts,.mxf,.braw,.r3d"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <p className="text-xs text-slate-500">
            Files upload in original quality — no compression, no transcoding. Keep this tab open while
            uploading; if the connection drops or the page reloads, progress is saved and only missing
            parts are sent.
          </p>
        </div>
      </Card>

      {notice && (
        <p className="rounded-lg border border-amber-800 bg-amber-950 px-3 py-2 text-sm text-amber-200">{notice}</p>
      )}

      {active.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Current uploads</h2>
          {active.map((u) => (
            <UploadCard
              key={u.localId}
              u={u}
              onResumePick={(localId) => {
                resumeTargetRef.current = localId;
                resumeInputRef.current?.click();
              }}
            />
          ))}
        </section>
      )}

      {finished.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Finished</h2>
          {finished.map((u) => (
            <div key={u.localId} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{u.filename}</p>
                <p className="text-xs text-slate-500">{formatBytes(u.size)}</p>
              </div>
              <div className="flex items-center gap-2">
                <StatusChip state={u.state} />
                <button className="text-xs text-slate-500 hover:text-slate-300" onClick={() => void uploadManager.remove(u.localId)}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <input
        ref={resumeInputRef}
        type="file"
        accept="video/*,.mp4,.mov,.mts,.mxf,.braw,.r3d"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void onResumePick(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function UploadCard({ u, onResumePick }: { u: UploadView; onResumePick: (localId: string) => void }) {
  const pct = percent(u.bytesUploaded, u.size);
  const tone = u.state === 'waiting_network' || u.state === 'needs_file' ? 'amber' : u.state === 'done' ? 'emerald' : 'sky';
  return (
    <Card>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-medium">{u.filename}</p>
          <StatusChip state={u.state} />
        </div>
        <ProgressBar value={pct} tone={tone} />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-slate-400">
          <span>
            {formatBytes(u.bytesUploaded)} / {formatBytes(u.size)} · {pct}% · parts {u.partsDone}/{u.totalParts}
          </span>
          {u.state === 'uploading' && (
            <span>
              {formatSpeed(u.speedBps)} · ETA {formatEta(u.etaSeconds)}
            </span>
          )}
        </div>
        {u.state === 'waiting_network' && (
          <p className="text-xs text-amber-300">Connection lost. Progress is saved — retrying automatically…</p>
        )}
        {u.state === 'needs_file' && (
          <p className="text-xs text-amber-300">
            The page was reloaded. Re-select <span className="font-mono">{u.filename}</span> to continue from part{' '}
            {u.partsDone + 1} — nothing already uploaded is sent again.
          </p>
        )}
        {u.state === 'error' && u.error && <p className="text-xs text-red-400">{u.error}</p>}
        <div className="flex gap-2">
          {(u.state === 'uploading' || u.state === 'queued' || u.state === 'waiting_network') && (
            <Button onClick={() => void uploadManager.pause(u.localId)}>Pause</Button>
          )}
          {u.state === 'paused' && (
            <Button kind="primary" onClick={() => void uploadManager.resume(u.localId)}>
              Resume
            </Button>
          )}
          {u.state === 'needs_file' && (
            <Button kind="primary" onClick={() => onResumePick(u.localId)}>
              Re-select file to resume
            </Button>
          )}
          {u.state === 'error' && (
            <Button kind="primary" onClick={() => void uploadManager.resume(u.localId)}>
              Retry
            </Button>
          )}
          {u.state !== 'done' && (
            <Button
              kind="ghost"
              onClick={() => {
                if (confirm(`Cancel the upload of ${u.filename}? Uploaded parts will be discarded.`)) {
                  void uploadManager.abort(u.localId);
                }
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
