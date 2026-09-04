import { useCallback, useEffect, useRef, useState } from 'react';
import { useUploads } from '../lib/managers';
import { useNavigate } from 'react-router-dom';
import type { ProjectInfo } from '@videovault/shared';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useAuth } from '../auth';
import Layout from '../components/Layout';
import { Button, ConfirmSheet, EmptyState, InputSheet, Notice, Sheet, SheetAction, Spinner } from '../components/ui';
import { IconChevronRight, IconFolder, IconLibrary, IconMore, IconPencil, IconTrash } from '../components/icons';

export default function LibraryPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [menuFor, setMenuFor] = useState<ProjectInfo | null>(null);
  const [renaming, setRenaming] = useState<ProjectInfo | null>(null);
  const [deleting, setDeleting] = useState<ProjectInfo | null>(null);

  const load = useCallback(() => {
    api
      .listProjects()
      .then((r) => setProjects(r.projects))
      .catch(() => setNotice('Could not load projects — check your connection.'));
  }, []);
  useEffect(load, [load]);

  // Keep counts fresh while uploads finish in the background.
  const uploads = useUploads();
  const doneCount = uploads.filter((u) => u.state === 'done').length;
  const prevDone = useRef(doneCount);
  useEffect(() => {
    if (doneCount > prevDone.current) load();
    prevDone.current = doneCount;
  }, [doneCount, load]);

  return (
    <Layout title="Library">
      <div className="space-y-2.5">
        {notice && <Notice text={notice} onDismiss={() => setNotice(null)} />}
        {projects === null && <Spinner />}

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {projects?.map((p) => (
          <div key={p.id} className="flex items-center rounded-xl border border-white/[0.08] bg-white/[0.03] transition-colors hover:bg-white/[0.05]">
            <button onClick={() => navigate(`/p/${p.id}`)} className="flex min-w-0 flex-1 items-center gap-3.5 p-4 text-left">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-zinc-400">
                <IconFolder size={19} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold">{p.name}</span>
                <span className="mt-0.5 block text-[12px] text-zinc-500">
                  {p.videoCount} file{p.videoCount === 1 ? '' : 's'}
                  {p.folderCount > 0 && ` · ${p.folderCount} folder${p.folderCount === 1 ? '' : 's'}`}
                  {' · '}
                  {formatDate(p.createdAt)}
                </span>
              </span>
              {!isAdmin && <IconChevronRight size={16} className="shrink-0 text-zinc-700" />}
            </button>
            {isAdmin && (
              <button
                onClick={() => setMenuFor(p)}
                className="mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-600 transition-colors hover:bg-white/[0.06] hover:text-zinc-300"
                aria-label={`Options for ${p.name}`}
              >
                <IconMore size={18} />
              </button>
            )}
          </div>
        ))}

        </div>

        {projects?.length === 0 && (
          <EmptyState
            icon={<IconLibrary size={32} />}
            title="No projects yet"
            sub={isAdmin ? 'Create your first project — one per trip works well.' : 'Ask your admin to create a project.'}
          />
        )}

        {isAdmin && projects !== null && (
          <div className="pt-1">
            <Button full size="lg" onClick={() => setCreating(true)}>
              New project
            </Button>
          </div>
        )}
      </div>

      <InputSheet
        open={creating}
        onClose={() => setCreating(false)}
        title="New project"
        placeholder="e.g. Himachal 2026"
        submitLabel="Create project"
        onSubmit={async (name) => {
          await api.createProject({ name });
          load();
        }}
      />

      <Sheet open={menuFor !== null} onClose={() => setMenuFor(null)} title={menuFor?.name}>
        <div className="space-y-0.5">
          <SheetAction
            icon={<IconPencil size={18} />}
            label="Rename"
            onClick={() => {
              setRenaming(menuFor);
              setMenuFor(null);
            }}
          />
          <SheetAction
            icon={<IconTrash size={18} />}
            label="Delete project"
            sub={menuFor && menuFor.videoCount > 0 ? `Deletes ${menuFor.videoCount} file(s) from storage` : 'Project is empty'}
            danger
            onClick={() => {
              setDeleting(menuFor);
              setMenuFor(null);
            }}
          />
        </div>
      </Sheet>

      <InputSheet
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename project"
        initial={renaming?.name ?? ''}
        submitLabel="Rename"
        onSubmit={async (name) => {
          await api.renameProject(renaming!.id, { name });
          load();
        }}
      />

      <ConfirmSheet
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        body={
          deleting && deleting.videoCount > 0
            ? `This permanently deletes the project and its ${deleting.videoCount} video(s) from cloud storage. This cannot be undone.`
            : 'This deletes the empty project. This cannot be undone.'
        }
        confirmLabel="Delete forever"
        onConfirm={async () => {
          await api.deleteProject(deleting!.id, (deleting?.videoCount ?? 0) > 0);
          load();
        }}
      />
    </Layout>
  );
}
