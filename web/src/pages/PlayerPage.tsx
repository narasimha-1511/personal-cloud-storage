import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { VideoInfo } from '@videovault/shared';
import { api } from '../lib/api';
import { formatBytes } from '../lib/format';

export default function PlayerPage() {
  const { id } = useParams<{ id: string }>();
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <div className="space-y-3">
      <Link to="/browse" className="text-sm text-slate-400 hover:text-slate-200">
        ← Back to browse
      </Link>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {video && (
        <div>
          <h1 className="truncate text-lg font-medium">{video.displayName}</h1>
          <p className="text-xs text-slate-500">{formatBytes(video.size)} · original quality</p>
        </div>
      )}
      {url && (
        // Streams straight from R2 with Range support, so seeking works and
        // nothing is proxied through the app server.
        <video src={url} controls playsInline className="w-full rounded-xl bg-black" />
      )}
      <p className="text-xs text-slate-500">
        Playback streams the original file. A very high-bitrate 4K original may stutter on slow
        connections — the download is always bit-exact regardless.
      </p>
    </div>
  );
}
