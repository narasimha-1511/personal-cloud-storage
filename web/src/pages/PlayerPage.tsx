import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { VideoInfo } from '@videovault/shared';
import { api } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import { startVideoDownload } from '../lib/startDownload';
import Layout from '../components/Layout';
import { Button, Notice, Spinner } from '../components/ui';
import { IconDownload, IconFile } from '../components/icons';

export default function PlayerPage() {
  const { id } = useParams<{ id: string }>();
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    Promise.all([api.getVideo(id), api.viewUrl(id)])
      .then(([v, u]) => {
        setVideo(v.video);
        setUrl(u.url);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load file'));
  }, [id]);

  const kind = video?.mimeType.startsWith('video/')
    ? 'video'
    : video?.mimeType.startsWith('image/')
      ? 'image'
      : video?.mimeType.startsWith('audio/')
        ? 'audio'
        : 'file';

  return (
    <Layout
      title={video?.displayName ?? 'Viewer'}
      back={video ? `/p/${video.projectId}${video.folderId ? `?f=${video.folderId}` : ''}` : '/'}
    >
      <div className="mx-auto w-full space-y-4 lg:max-w-4xl">
        {error && <Notice text={error} />}
        {!url && !error && <Spinner />}
        {url && kind === 'video' && (
          // Streams straight from R2 with Range support — seeking works and
          // nothing passes through the app server.
          <video src={url} controls autoPlay playsInline className="aspect-video w-full rounded-2xl bg-black" />
        )}
        {url && kind === 'image' && (
          <img src={url} alt={video?.displayName} className="w-full rounded-2xl bg-black object-contain" />
        )}
        {url && kind === 'audio' && <audio src={url} controls className="w-full" />}
        {url && kind === 'file' && (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] py-14">
            <span className="text-zinc-600">
              <IconFile size={36} />
            </span>
            <p className="text-[13px] text-zinc-400">No preview for this file type — download to open it.</p>
          </div>
        )}
        {video && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-zinc-500 tabular-nums">
              {formatBytes(video.size)} · original quality · {formatDate(video.createdAt)}
            </p>
            <Button
              onClick={() =>
                void startVideoDownload(video)
                  .then((mode) => {
                    if (mode !== 'cancelled') {
                      setToast(mode === 'managed' ? 'Download started — see Transfers' : 'Download handed to the browser');
                      setTimeout(() => setToast(null), 3000);
                    }
                  })
                  .catch((err) => setError(err instanceof Error ? err.message : 'Download failed'))
              }
            >
              <IconDownload size={16} /> Download
            </Button>
          </div>
        )}
        {kind === 'video' && (
          <p className="text-xs leading-relaxed text-zinc-600">
            Playback streams the untouched original. A high-bitrate 4K file may stutter on slow connections — the
            download is always bit-exact regardless.
          </p>
        )}
      </div>
      {toast && (
        <div className="fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-4">
          <span className="rounded-lg border border-white/10 bg-[#18181b] px-4 py-2.5 text-[12px] font-medium text-zinc-200">{toast}</span>
        </div>
      )}
    </Layout>
  );
}
