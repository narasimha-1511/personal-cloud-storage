/**
 * Safe SD-card cleanup planning: a local file may be deleted ONLY when a
 * file with the exact same name AND size is READY in the vault — i.e. fully
 * uploaded and verified. Anything still uploading, queued, or unknown is
 * kept, and --keep pins files regardless.
 */

export interface CardFile {
  path: string;
  name: string;
  size: number;
}

export interface FreePlan {
  toDelete: CardFile[];
  toKeep: CardFile[];
  freedBytes: number;
}

export function safeSetFrom(videos: { originalFilename: string; size: number; status: string }[]): Set<string> {
  return new Set(videos.filter((v) => v.status === 'READY').map((v) => `${v.originalFilename}:${v.size}`));
}

export function planFree(files: CardFile[], safe: Set<string>, keep: string[]): FreePlan {
  const pins = keep.map((k) => k.trim()).filter(Boolean);
  const pinned = (f: CardFile) => pins.some((k) => f.name.includes(k));
  const toDelete: CardFile[] = [];
  const toKeep: CardFile[] = [];
  for (const f of files) {
    if (safe.has(`${f.name}:${f.size}`) && !pinned(f)) toDelete.push(f);
    else toKeep.push(f);
  }
  return { toDelete, toKeep, freedBytes: toDelete.reduce((s, f) => s + f.size, 0) };
}
