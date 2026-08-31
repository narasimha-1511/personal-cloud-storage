import { useEffect, useState } from 'react';
import type { VideoInfo } from '@videovault/shared';
import { api } from '../lib/api';
import { downloadManager, ensureManagersInit, useDownloads } from '../lib/managers';
import { supportsFileSystemAccess } from '../lib/downloadManager';
import { formatBytes, formatDate, formatEta, formatSpeed, percent } from '../lib/format';
import { Button, Card, ProgressBar, StatusChip } from '../components/ui';

export default function EditorPage() {
  const [videos, setVideos] = useState<VideoInfo[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const downloads = useDownloads();
  const fsa = supportsFileSystemAccess();

  useEffect(() => {
    void ensureManagersInit();
    api
      .listVideos({ status: 'READY' })
      .then((r) => setVideos(r.videos))
      .catch(() => setNotice('Could not load videos — are you online?'));
  }, []);

  async function startDownload(v: VideoInfo) {
    setNotice(null);
    if (!fsa) {
      // Fallback: hand the presigned URL to the browser's own download
      // manager. Resume support then depends on the browser.
      try {
        const { url } = await api.downloadUrl(v.id);
        const a = document.createElement('a');
        a.href = url;
        a.download = v.displayName;
        a.click();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Could not start download');
      }
      return;
    }
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: v.displayName,
        types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.mov', '.mts'] } }],
      });
      await downloadManager.start({ id: v.id, displayName: v.displayName, size: v.size }, handle);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return; // user cancelled picker
      setNotice(err instanceof Error ? err.message : 'Could not start download');
    }
  }

  const downloadByVideo = new Map(downloads.map((d) => [d.videoId, d]));

  return (
    <div className="space-y-4">
      {!fsa && (
        <p className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-400">
          This browser doesn't support resumable managed downloads (File System Access API). Downloads
          will use the browser's own download manager — Chrome or Edge is recommended for
          multi-gigabyte files.
        </p>
      )}
      {notice && <p className="rounded-lg border border-amber-800 bg-amber-950 px-3 py-2 text-sm text-amber-200">{notice}</p>}

      {downloads.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Downloads</h2>
          {downloads.map((d) => {
            const pct = percent(d.bytesWritten, d.totalSize);
            return (
              <Card key={d.videoId}>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-sm font-medium">{d.filename}</p>
                    <StatusChip state={d.state} />
                  </div>
                  <ProgressBar value={pct} tone={d.state === 'done' ? 'emerald' : d.state === 'waiting_network' ? 'amber' : 'sky'} />
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-slate-400">
                    <span>
                      {formatBytes(d.bytesWritten)} / {formatBytes(d.totalSize)} · {pct}%
                    </span>
                    {d.state === 'downloading' && (
                      <span>
                        {formatSpeed(d.speedBps)} · ETA {formatEta(d.etaSeconds)}
                      </span>
                    )}
                  </div>
                  {d.state === 'waiting_network' && (
                    <p className="text-xs text-amber-300">
                      Connection lost — resuming from {formatBytes(d.bytesWritten)} when you're back online.
                    </p>
                  )}
                  {d.state === 'error' && d.error && <p className="text-xs text-red-400">{d.error}</p>}
                  <div className="flex gap-2">
                    {d.state === 'downloading' && <Button onClick={() => downloadManager.pause(d.videoId)}>Pause</Button>}
                    {(d.state === 'paused' || d.state === 'waiting_network' || d.state === 'error') && (
                      <Button
                        kind="primary"
                        onClick={() =>
                          void downloadManager.resume(d.videoId).then((r) => {
                            if (r === 'needs_handle') {
                              setNotice('Could not reopen the file. Click Download on the video to pick it again — progress is kept.');
                            }
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
              </Card>
            );
          })}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Ready footage</h2>
        {videos.map((v) => {
          const d = downloadByVideo.get(v.id);
          return (
            <div key={v.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{v.displayName}</p>
                <p className="text-xs text-slate-500">
                  {formatBytes(v.size)} · {formatDate(v.createdAt)} · by {v.ownerUsername}
                </p>
              </div>
              <Button kind="primary" onClick={() => void startDownload(v)} disabled={d?.state === 'downloading'}>
                {d?.state === 'done' ? 'Download again' : 'Download'}
              </Button>
            </div>
          );
        })}
        {videos.length === 0 && <p className="text-sm text-slate-500">No footage is ready yet.</p>}
      </section>
    </div>
  );
}
