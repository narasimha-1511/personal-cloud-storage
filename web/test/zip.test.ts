import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ZipWriter, crc32, uniqueEntryName, zipEntryName, type ZipWriterOptions } from '../src/lib/zip';
import { concat, noise, run, withArchive } from './archive';

interface Entry {
  name: string;
  data: Uint8Array;
}

/** Streams entries through ZipWriter the way the download path does. */
async function buildZip(entries: Entry[], options?: ZipWriterOptions): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const zip = new ZipWriter(async (chunk) => {
    // Copy: a real sink may retain the buffer, and callers reuse chunks.
    chunks.push(new Uint8Array(chunk));
  }, options);
  for (const e of entries) {
    await zip.beginFile({ name: e.name, size: e.data.length, lastModified: Date.UTC(2026, 8, 15, 10, 30, 0) });
    // Deliberately split so the CRC and size accumulate across chunks.
    for (let i = 0; i < e.data.length; i += 7) {
      await zip.write(e.data.subarray(i, Math.min(i + 7, e.data.length)));
    }
    await zip.endFile();
  }
  await zip.finish();
  return concat(chunks);
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('crc32', () => {
  it('matches the reference value for "123456789"', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
  });

  it('is the same whether fed whole or in pieces', () => {
    const data = noise(5000, 7);
    let streamed = 0;
    for (let i = 0; i < data.length; i += 13) {
      streamed = crc32(data.subarray(i, i + 13), streamed);
    }
    expect(streamed).toBe(crc32(data));
  });

  it('is zero for no data', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('entry names', () => {
  it('flattens separators and strips leading dots', () => {
    expect(zipEntryName('a/b\\c.mp4')).toBe('a_b_c.mp4');
    expect(zipEntryName('../../etc/passwd')).toBe('etc_passwd');
    expect(zipEntryName('/absolute/clip.mp4')).toBe('absolute_clip.mp4');
    expect(zipEntryName('   ')).toBe('file');
  });

  it('numbers duplicates instead of overwriting them', () => {
    const used = new Set<string>();
    expect(uniqueEntryName(used, 'DJI_0001.JPG')).toBe('DJI_0001.JPG');
    expect(uniqueEntryName(used, 'DJI_0001.JPG')).toBe('DJI_0001 (2).JPG');
    expect(uniqueEntryName(used, 'DJI_0001.JPG')).toBe('DJI_0001 (3).JPG');
    expect(uniqueEntryName(used, 'notes')).toBe('notes');
    expect(uniqueEntryName(used, 'notes')).toBe('notes (2)');
  });

  it('treats names differing only in case as duplicates, like macOS and Windows do', () => {
    const used = new Set<string>();
    expect(uniqueEntryName(used, 'Clip.mp4')).toBe('Clip.mp4');
    expect(uniqueEntryName(used, 'clip.mp4')).toBe('clip (2).mp4');
  });
});

describe('ZipWriter', () => {
  const sample: Entry[] = [
    { name: 'DJI_0001.JPG', data: noise(4096, 11) },
    { name: 'Day 1 – drone “final”.mp4', data: noise(70_000, 23) },
    { name: 'empty.txt', data: new Uint8Array(0) },
    { name: 'notes.txt', data: bytes('resumable raw video transfer\n') },
  ];

  it('produces an archive the system unzip reports as intact', async () => {
    const zip = await buildZip(sample);
    await withArchive(zip, async (path) => {
      const { stdout } = await run('unzip', ['-t', path]);
      expect(stdout).toContain('No errors detected');
    });
  });

  it('round-trips every byte, including UTF-8 names and an empty file', async () => {
    const zip = await buildZip(sample);
    await withArchive(zip, async (path, dir) => {
      const out = join(dir, 'out');
      await run('unzip', ['-q', path, '-d', out]);
      for (const e of sample) {
        const got = await readFile(join(out, e.name));
        expect(new Uint8Array(got), `contents of ${e.name}`).toEqual(e.data);
      }
    });
  });

  it('writes a plain (non-ZIP64) archive when nothing needs 64-bit fields', async () => {
    const zip = await buildZip(sample);
    // The ZIP64 end-of-central-directory signature must be absent entirely.
    expect(indexOfSignature(zip, 0x06064b50)).toBe(-1);
  });

  it('produces a readable archive on the ZIP64 path', async () => {
    // A real 4 GB entry is not testable here; lowering the threshold puts every
    // entry through the same 64-bit code the big files will take.
    const zip = await buildZip(sample, { zip64Threshold: 1 });
    expect(indexOfSignature(zip, 0x06064b50)).toBeGreaterThan(0);
    await withArchive(zip, async (path, dir) => {
      const { stdout } = await run('unzip', ['-t', path]);
      expect(stdout).toContain('No errors detected');
      const out = join(dir, 'out');
      await run('unzip', ['-q', path, '-d', out]);
      for (const e of sample) {
        expect(new Uint8Array(await readFile(join(out, e.name))), `contents of ${e.name}`).toEqual(e.data);
      }
    });
  });

  it('switches to ZIP64 only for the entries past the threshold', async () => {
    // First entry small, second past the threshold: the archive must mix both.
    const entries: Entry[] = [
      { name: 'small.bin', data: noise(100, 3) },
      { name: 'big.bin', data: noise(900, 5) },
    ];
    const zip = await buildZip(entries, { zip64Threshold: 500 });
    await withArchive(zip, async (path, dir) => {
      const out = join(dir, 'out');
      await run('unzip', ['-q', path, '-d', out]);
      expect(new Uint8Array(await readFile(join(out, 'small.bin')))).toEqual(entries[0]!.data);
      expect(new Uint8Array(await readFile(join(out, 'big.bin')))).toEqual(entries[1]!.data);
    });
  });

  it('lists every entry, stored and with its real size', async () => {
    // ASCII names only: the `zipinfo` shipped with macOS re-encodes what it
    // prints, which would make this assert the tool's output encoding rather
    // than the archive. Non-ASCII names are covered by the round-trip above.
    const ascii: Entry[] = [
      { name: 'DJI_0001.JPG', data: noise(4096, 11) },
      { name: 'clip.mp4', data: noise(70_000, 23) },
    ];
    const zip = await buildZip(ascii);
    await withArchive(zip, async (path) => {
      const { stdout } = await run('zipinfo', [path]);
      for (const e of ascii) {
        expect(stdout).toMatch(new RegExp(`stor.*${e.name.replace('.', '\\.')}`));
        expect(stdout).toContain(String(e.data.length));
      }
    });
  });

  it('reports how far the open entry has got, so a retry can resume it', async () => {
    const zip = new ZipWriter(async () => {});
    await zip.beginFile({ name: 'clip.mp4', size: 30 });
    expect(zip.entryBytesWritten).toBe(0);
    await zip.write(noise(12));
    expect(zip.entryBytesWritten).toBe(12);
    await zip.write(noise(18));
    expect(zip.entryBytesWritten).toBe(30);
    await zip.endFile();
    expect(zip.entryBytesWritten).toBe(0);
  });

  it('refuses more bytes than the entry declared', async () => {
    const zip = new ZipWriter(async () => {});
    await zip.beginFile({ name: 'clip.mp4', size: 10 });
    await zip.write(noise(10));
    await expect(zip.write(noise(1))).rejects.toThrow(/larger than its recorded size/);
  });

  it('refuses to close an entry that is short', async () => {
    const zip = new ZipWriter(async () => {});
    await zip.beginFile({ name: 'clip.mp4', size: 10 });
    await zip.write(noise(4));
    await expect(zip.endFile()).rejects.toThrow(/is 4 bytes, expected 10/);
  });

  it('refuses to interleave entries', async () => {
    const zip = new ZipWriter(async () => {});
    await zip.beginFile({ name: 'a.bin', size: 1 });
    await expect(zip.beginFile({ name: 'b.bin', size: 1 })).rejects.toThrow(/already open/);
  });

  it('writes a valid empty archive', async () => {
    // Just the end-of-central-directory record, with a zero entry count.
    const zip = await buildZip([]);
    expect(zip.length).toBe(22);
    expect(indexOfSignature(zip, 0x06054b50)).toBe(0);
    expect(zip[8]).toBe(0);
    expect(zip[9]).toBe(0);
  });
});

/** Finds a little-endian 4-byte signature, or -1. */
function indexOfSignature(buf: Uint8Array, sig: number): number {
  const b0 = sig & 0xff;
  const b1 = (sig >>> 8) & 0xff;
  const b2 = (sig >>> 16) & 0xff;
  const b3 = (sig >>> 24) & 0xff;
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === b0 && buf[i + 1] === b1 && buf[i + 2] === b2 && buf[i + 3] === b3) return i;
  }
  return -1;
}
