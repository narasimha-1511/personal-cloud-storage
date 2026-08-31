import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ProjectInfo } from '@videovault/shared';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useAuth } from '../auth';
import Layout from '../components/Layout';
import { Button, ConfirmSheet, EmptyState, InputSheet, Notice, Sheet, SheetAction, Spinner } from '../components/ui';

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

  return (
    <Layout title="Library">
      <div className="space-y-3">
        {notice && <Notice text={notice} onDismiss={() => setNotice(null)} />}
        {projects === null && <Spinner />}

        {projects?.map((p) => (
          <div key={p.id} className="group relative">
            <button
              onClick={() => navigate(`/p/${p.id}`)}
              className="block w-full rounded-2xl border border-white/8 bg-gradient-to-br from-white/[0.06] to-white/[0.02] p-5 text-left transition-all hover:border-white/15 active:scale-[0.99]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500/25 to-cyan-400/10 text-lg">
                    ⛰
                  </span>
                  <p className="truncate text-base font-bold">{p.name}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {p.videoCount} video{p.videoCount === 1 ? '' : 's'}
                    {p.folderCount > 0 && ` · ${p.folderCount} folder${p.folderCount === 1 ? '' : 's'}`}
                    {' · '}
                    {formatDate(p.createdAt)}
                  </p>
                </div>
                <span className="mt-1 text-slate-600">›</span>
              </div>
            </button>
            {isAdmin && (
              <button
                onClick={() => setMenuFor(p)}
                className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
                aria-label={`Options for ${p.name}`}
              >
                ⋯
              </button>
            )}
          </div>
        ))}

        {projects?.length === 0 && (
          <EmptyState
            icon="⛰"
            title="No projects yet"
            sub={isAdmin ? 'Create your first project — one per trip works well.' : 'Ask your admin to create a project.'}
          />
        )}

        {isAdmin && projects !== null && (
          <Button full size="lg" onClick={() => setCreating(true)}>
            + New project
          </Button>
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
        <div className="space-y-1">
          <SheetAction
            icon="✏️"
            label="Rename"
            onClick={() => {
              setRenaming(menuFor);
              setMenuFor(null);
            }}
          />
          <SheetAction
            icon="🗑"
            label="Delete project"
            sub={menuFor && menuFor.videoCount > 0 ? `Deletes ${menuFor.videoCount} video(s) from storage` : 'Project is empty'}
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
