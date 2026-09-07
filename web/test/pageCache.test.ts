import { beforeEach, describe, expect, it } from 'vitest';
import type { VideoInfo } from '@videovault/shared';
import {
  clearPageCache,
  invalidateSiblings,
  pageKey,
  readPage,
  thumbsUsable,
  writePage,
} from '../src/lib/pageCache';

function video(id: string): VideoInfo {
  return {
    id,
    projectId: 'p1',
    folderId: null,
    ownerId: 'u1',
    ownerUsername: 'narasimha',
    objectKey: `videos/${id}/original`,
    originalFilename: `${id}.JPG`,
    displayName: `${id}.JPG`,
    size: 1000,
    mimeType: 'image/jpeg',
    status: 'READY',
    hidden: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('project page cache', () => {
  beforeEach(() => clearPageCache());

  it('separates the project root from its folders', () => {
    expect(pageKey('p1', null)).toBe('p1:');
    expect(pageKey('p1', 'f1')).toBe('p1:f1');
    expect(pageKey('p1', null)).not.toBe(pageKey('p1', 'f1'));
  });

  it('returns nothing for a page never visited', () => {
    expect(readPage(pageKey('p1', null))).toBeNull();
  });

  it('merges partial writes so scroll survives a data refresh', () => {
    const key = pageKey('p1', null);
    writePage(key, { scrollY: 1840, limit: 240 });
    writePage(key, { videos: [video('v1')], fetchedAt: 123 });

    const hit = readPage(key)!;
    // The reload must not wipe where the user was.
    expect(hit.scrollY).toBe(1840);
    expect(hit.limit).toBe(240);
    expect(hit.videos?.map((v) => v.id)).toEqual(['v1']);
  });

  it('evicts least-recently-read pages beyond the cap, keeping recent ones', () => {
    for (let i = 0; i < 8; i++) writePage(pageKey('p1', `f${i}`), { scrollY: i });
    // Re-read the oldest so it is no longer the least recently used.
    expect(readPage(pageKey('p1', 'f0'))).not.toBeNull();

    writePage(pageKey('p1', 'f8'), { scrollY: 8 });

    expect(readPage(pageKey('p1', 'f0'))).not.toBeNull();
    expect(readPage(pageKey('p1', 'f8'))).not.toBeNull();
    // f1 was the least recently used and is the one that goes.
    expect(readPage(pageKey('p1', 'f1'))).toBeNull();
  });

  it('drops sibling folders after a mutation but keeps the current page', () => {
    const here = pageKey('p1', 'f1');
    writePage(here, { scrollY: 500 });
    writePage(pageKey('p1', 'f2'), { scrollY: 10 });
    writePage(pageKey('p1', null), { scrollY: 20 });
    writePage(pageKey('p2', 'f9'), { scrollY: 30 });

    // Moving a file changes counts in the source and destination folders.
    invalidateSiblings('p1', here);

    expect(readPage(here)?.scrollY).toBe(500);
    expect(readPage(pageKey('p1', 'f2'))).toBeNull();
    expect(readPage(pageKey('p1', null))).toBeNull();
    // A different project is untouched.
    expect(readPage(pageKey('p2', 'f9'))?.scrollY).toBe(30);
  });

  it('does not treat a project id prefix as a sibling', () => {
    writePage(pageKey('p1', 'f1'), { scrollY: 1 });
    writePage(pageKey('p10', 'f1'), { scrollY: 2 });

    invalidateSiblings('p1', pageKey('p1', 'zzz'));

    expect(readPage(pageKey('p1', 'f1'))).toBeNull();
    // p10 must not be swept up by a naive prefix match on "p1".
    expect(readPage(pageKey('p10', 'f1'))?.scrollY).toBe(2);
  });

  it('refuses signed thumbnail URLs that are expired or about to expire', () => {
    const base = {
      project: null,
      folders: [],
      videos: null,
      thumbs: {},
      realThumbs: [],
      scrollY: 0,
      limit: 0,
      fetchedAt: 0,
    };
    expect(thumbsUsable({ ...base, thumbsExpireAt: 0 })).toBe(false);
    expect(thumbsUsable({ ...base, thumbsExpireAt: Date.now() - 1000 })).toBe(false);
    // Inside the two-minute safety margin: a tile would 403 mid-scroll.
    expect(thumbsUsable({ ...base, thumbsExpireAt: Date.now() + 60_000 })).toBe(false);
    expect(thumbsUsable({ ...base, thumbsExpireAt: Date.now() + 30 * 60_000 })).toBe(true);
  });

  it('will not resurrect an entry that was invalidated while a load was in flight', () => {
    const away = pageKey('p1', 'f2');
    writePage(away, { scrollY: 900, limit: 120 });
    invalidateSiblings('p1', pageKey('p1', 'f1'));
    expect(readPage(away)).toBeNull();

    // The response for the folder we left finally lands. It must not re-create
    // the entry, or stale counts would outlive the invalidation and the saved
    // scroll position would come back as 0.
    writePage(away, { videos: [video('v1')], fetchedAt: 1 }, { onlyIfPresent: true });
    expect(readPage(away)).toBeNull();

    // The same write for a page that still exists is applied normally.
    const here = pageKey('p1', 'f1');
    writePage(here, { scrollY: 300 });
    writePage(here, { videos: [video('v2')] }, { onlyIfPresent: true });
    expect(readPage(here)?.videos?.map((v) => v.id)).toEqual(['v2']);
    expect(readPage(here)?.scrollY).toBe(300);
  });

  it('remembers which cached URLs are real thumbnails rather than stand-in originals', () => {
    const key = pageKey('p1', null);
    writePage(key, {
      thumbs: { v1: 'https://signed/thumb', v2: 'https://signed/original' },
      realThumbs: ['v1'],
      thumbsExpireAt: Date.now() + 30 * 60_000,
    });

    const hit = readPage(key)!;
    // v2's derivative was still generating, so its URL is the original and it
    // must be asked about again rather than treated as done.
    expect(hit.realThumbs).toEqual(['v1']);
    expect(Object.keys(hit.thumbs)).toHaveLength(2);
    expect(thumbsUsable(hit)).toBe(true);
  });

  it('clears everything on sign-out', () => {
    writePage(pageKey('p1', null), { scrollY: 1, thumbs: { v1: 'https://signed' } });
    clearPageCache();
    expect(readPage(pageKey('p1', null))).toBeNull();
  });
});
