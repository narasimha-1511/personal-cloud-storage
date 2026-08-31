import type { VideoInfo } from '@videovault/shared';
import { api } from './api';
import { downloadManager, ensureManagersInit } from './managers';
import { supportsFileSystemAccess } from './downloadManager';

/**
 * Starts a video download. With the File System Access API (Chrome/Edge
 * desktop) it's fully resumable and shows in Transfers; elsewhere it falls
 * back to the browser's own download manager via the presigned URL.
 * Returns 'managed', 'native', or 'cancelled'.
 */
export async function startVideoDownload(video: VideoInfo): Promise<'managed' | 'native' | 'cancelled'> {
  await ensureManagersInit();
  if (!supportsFileSystemAccess()) {
    const { url } = await api.downloadUrl(video.id);
    const a = document.createElement('a');
    a.href = url;
    a.download = video.displayName;
    a.click();
    return 'native';
  }
  try {
    const handle = await window.showSaveFilePicker({ suggestedName: video.displayName });
    await downloadManager.start({ id: video.id, displayName: video.displayName, size: video.size }, handle);
    return 'managed';
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
    throw err;
  }
}
