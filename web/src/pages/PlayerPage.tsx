import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { VideoInfo } from '@videovault/shared';
import { api } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import { startVideoDownload } from '../lib/startDownload';
import Layout from '../components/Layout';
import { Button, Notice, Spinner } from '../components/ui';

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
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load video'));
  }, [id]);

  return (
    <Layout title={video?.displayName ?? 'Player'} back={video ? `/p/${video.projectId}${video.folderId ? `?f=${video.folderId}` : ''}` : '/'}>
      <div className="space-y-4">
        {error && <Notice text={error} />}
        {!url && !error && <Spinner />}
        {url && (
          // Streams straight from R2 with Range support — seeking works and
          // nothing passes through the app server.
          <video src={url} controls autoPlay playsInline className="aspect-video w-full rounded-2xl bg-black shadow-2xl" />
        )}
        {video && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500 tabular-nums">
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
              ⬇ Download
            </Button>
          </div>
        )}
        <p className="text-xs leading-relaxed text-slate-600">
          Playback streams the untouched original. A high-bitrate 4K file may stutter on slow connections — the download is
          always bit-exact regardless.
        </p>
      </div>
      {toast && (
        <div className="fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-4">
          <span className="rounded-full border border-white/10 bg-[#0d1424] px-4 py-2 text-xs font-semibold text-slate-200 shadow-xl">{toast}</span>
        </div>
      )}
    </Layout>
  );
}
