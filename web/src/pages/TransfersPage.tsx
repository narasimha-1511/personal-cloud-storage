import { useEffect, useRef, useState } from 'react';
import { downloadManager, ensureManagersInit, uploadManager, useDownloads, useUploads } from '../lib/managers';
import { formatBytes, formatEta, formatSpeed, percent } from '../lib/format';
import type { UploadView } from '../lib/uploadManager';
import type { DownloadView } from '../lib/downloadManager';
import Layout from '../components/Layout';
import { Button, ConfirmSheet, EmptyState, Notice, ProgressBar, StatusChip } from '../components/ui';

export default function TransfersPage() {
  const uploads = useUploads();
  const downloads = useDownloads();
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<UploadView | null>(null);
  const resumeInput = useRef<HTMLInputElement>(null);
  const resumeTarget = useRef<string | null>(null);

  useEffect(() => {
    void ensureManagersInit();
  }, []);

  const activeUploads = uploads.filter((u) => u.state !== 'done' && u.state !== 'aborted');
  const finishedUploads = uploads.filter((u) => u.state === 'done' || u.state === 'aborted');

  async function onResumePick(files: FileList) {
    const targetId = resumeTarget.current;
    resumeTarget.current = null;
    const pending = uploads.filter((u) => u.state === 'needs_file');
    for (const file of Array.from(files)) {
      const target =
        pending.find((u) => u.localId === targetId && u.filename === file.name && u.size === file.size) ??
        pending.find((u) => u.filename === file.name && u.size === file.size);
      if (!target) {
        setNotice(`“${file.name}” doesn't match the interrupted upload — pick the exact original file (same name and size).`);
        continue;
      }
      try {
        await uploadManager.provideFile(target.localId, file);
        setNotice(null);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Could not resume');
      }
    }
  }

  return (
    <Layout title="Transfers">
      <div className="space-y-6">
        {notice && <Notice text={notice} onDismiss={() => setNotice(null)} />}

        <section>
          <h2 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-slate-500">Uploads</h2>
          <div className="space-y-2">
            {activeUploads.map((u) => (
              <UploadCard
                key={u.localId}
                u={u}
                onResume={() => {
                  if (u.state === 'needs_file') {
                    resumeTarget.current = u.localId;
                    resumeInput.current?.click();
                  } else {
                    void uploadManager.resume(u.localId);
                  }
                }}
                onPause={() => void uploadManager.pause(u.localId)}
                onCancel={() => setCancelling(u)}
              />
            ))}
          </div>
          {activeUploads.length === 0 && (
            <EmptyState icon="⇧" title="No active uploads" sub="Add videos from any project in the Library." />
          )}
        </section>

        {downloads.length > 0 && (
          <section>
            <h2 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-slate-500">Downloads</h2>
            <div className="space-y-2">
              {downloads.map((d) => (
                <DownloadCard key={d.videoId} d={d} onNotice={setNotice} />
              ))}
            </div>
          </section>
        )}

        {finishedUploads.length > 0 && (
          <section>
            <h2 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-slate-500">Finished</h2>
            <div className="space-y-2">
              {finishedUploads.map((u) => (
                <div key={u.localId} className="flex items-center justify-between gap-3 rounded-2xl border border-white/6 bg-white/[0.03] px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-300">{u.filename}</p>
                    <p className="text-[11px] text-slate-600 tabular-nums">{formatBytes(u.size)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusChip state={u.state} />
                    <button
                      className="text-xs text-slate-600 hover:text-slate-300"
                      onClick={() => void uploadManager.remove(u.localId)}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <input
        ref={resumeInput}
        type="file"
        accept="video/*,.mp4,.mov,.mts,.mxf,.braw,.r3d"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void onResumePick(e.target.files);
          e.target.value = '';
        }}
      />

      <ConfirmSheet
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title={`Cancel “${cancelling?.filename}”?`}
        body="The upload stops and already-uploaded parts are discarded. You'd start from zero next time."
        confirmLabel="Cancel upload"
        onConfirm={async () => {
          await uploadManager.abort(cancelling!.localId);
        }}
      />
    </Layout>
  );
}

function UploadCard({
  u,
  onResume,
  onPause,
  onCancel,
}: {
  u: UploadView;
  onResume: () => void;
  onPause: () => void;
  onCancel: () => void;
}) {
  const pct = percent(u.bytesUploaded, u.size);
  const tone = u.state === 'waiting_network' || u.state === 'needs_file' ? 'amber' : 'sky';
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-semibold">{u.filename}</p>
        <StatusChip state={u.state} />
      </div>
      <ProgressBar value={pct} tone={tone} />
      <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-[11px] text-slate-500">
        <span className="tabular-nums">
          {formatBytes(u.bytesUploaded)} / {formatBytes(u.size)} · {pct}% · part {Math.min(u.partsDone + 1, u.totalParts)} of {u.totalParts}
        </span>
        {u.state === 'uploading' && (
          <span className="tabular-nums">
            {formatSpeed(u.speedBps)} · {formatEta(u.etaSeconds)} left
          </span>
        )}
      </div>
      {u.state === 'waiting_network' && (
        <p className="mt-2 text-xs text-amber-300/90">Connection lost — progress is safe, retrying automatically.</p>
      )}
      {u.state === 'needs_file' && (
        <p className="mt-2 text-xs text-amber-300/90">
          The app was reloaded. Re-select this exact file to continue from {pct}% — nothing is re-uploaded.
        </p>
      )}
      {u.state === 'error' && u.error && <p className="mt-2 text-xs text-red-400">{u.error}</p>}
      <div className="mt-3 flex gap-2">
        {(u.state === 'uploading' || u.state === 'queued') && <Button onClick={onPause}>Pause</Button>}
        {(u.state === 'paused' || u.state === 'error') && (
          <Button kind="primary" onClick={onResume}>
            Resume
          </Button>
        )}
        {u.state === 'needs_file' && (
          <Button kind="primary" onClick={onResume}>
            Re-select file
          </Button>
        )}
        <Button kind="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function DownloadCard({ d, onNotice }: { d: DownloadView; onNotice: (s: string | null) => void }) {
  const pct = percent(d.bytesWritten, d.totalSize);
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-semibold">{d.filename}</p>
        <StatusChip state={d.state} />
      </div>
      <ProgressBar value={pct} tone={d.state === 'done' ? 'emerald' : d.state === 'waiting_network' ? 'amber' : 'sky'} />
      <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-[11px] text-slate-500">
        <span className="tabular-nums">
          {formatBytes(d.bytesWritten)} / {formatBytes(d.totalSize)} · {pct}%
        </span>
        {d.state === 'downloading' && (
          <span className="tabular-nums">
            {formatSpeed(d.speedBps)} · {formatEta(d.etaSeconds)} left
          </span>
        )}
      </div>
      {d.state === 'waiting_network' && (
        <p className="mt-2 text-xs text-amber-300/90">Connection lost — resuming from {formatBytes(d.bytesWritten)} when back online.</p>
      )}
      {d.state === 'error' && d.error && <p className="mt-2 text-xs text-red-400">{d.error}</p>}
      <div className="mt-3 flex gap-2">
        {d.state === 'downloading' && <Button onClick={() => downloadManager.pause(d.videoId)}>Pause</Button>}
        {(d.state === 'paused' || d.state === 'waiting_network' || d.state === 'error') && (
          <Button
            kind="primary"
            onClick={() =>
              void downloadManager.resume(d.videoId).then((r) => {
                if (r === 'needs_handle')
                  onNotice('Could not reopen the file — start the download again from the video; progress on disk is kept.');
              })
            }
          >
            Resume
          </Button>
        )}
        <Button kind="ghost" onClick={() => void downloadManager.remove(d.videoId)}>
          Clear
        </Button>
      </div>
    </div>
  );
}
