import { describe, expect, it } from 'vitest';
import { planFree, safeSetFrom } from '../src/free.js';

const f = (name: string, size: number) => ({ path: `/sd/${name}`, name, size });

describe('vvup free planning', () => {
  it('deletes only files verified READY in the vault, by exact name AND size', () => {
    const safe = safeSetFrom([
      { originalFilename: 'A.MP4', size: 100, status: 'READY' },
      { originalFilename: 'B.MP4', size: 200, status: 'UPLOADING' },
      { originalFilename: 'C.MP4', size: 300, status: 'READY' },
    ]);
    const files = [f('A.MP4', 100), f('B.MP4', 200), f('C.MP4', 999), f('D.MP4', 400)];
    const plan = planFree(files, safe, []);
    // B is still uploading, C's size differs (different recording), D unknown.
    expect(plan.toDelete.map((x) => x.name)).toEqual(['A.MP4']);
    expect(plan.toKeep.map((x) => x.name)).toEqual(['B.MP4', 'C.MP4', 'D.MP4']);
    expect(plan.freedBytes).toBe(100);
  });

  it('--keep pins files even when they are safe to delete', () => {
    const safe = safeSetFrom([
      { originalFilename: 'DJI_0214_D.MP4', size: 100, status: 'READY' },
      { originalFilename: 'DJI_0215_D.MP4', size: 100, status: 'READY' },
    ]);
    const plan = planFree([f('DJI_0214_D.MP4', 100), f('DJI_0215_D.MP4', 100)], safe, ['0214', ' ', '']);
    expect(plan.toDelete.map((x) => x.name)).toEqual(['DJI_0215_D.MP4']);
    expect(plan.toKeep.map((x) => x.name)).toEqual(['DJI_0214_D.MP4']);
  });
});
