import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Test helpers that check produced archives with the system `unzip` rather
 * than with the writer that made them — a self-consistent reader would happily
 * agree with a malformed ZIP.
 */

export const run = promisify(execFile);

/** Writes the archive to a temp dir and hands the path to `fn`. */
export async function withArchive<T>(
  bytes: Uint8Array,
  fn: (path: string, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'vv-zip-'));
  const path = join(dir, 'archive.zip');
  await writeFile(path, bytes);
  try {
    return await fn(path, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Extracts the archive and returns every entry's bytes, keyed by name. */
export async function unzipAll(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  return withArchive(bytes, async (path, dir) => {
    const out = join(dir, 'out');
    await run('unzip', ['-q', path, '-d', out]);
    const { stdout } = await run('zipinfo', ['-1', path]);
    const entries = new Map<string, Uint8Array>();
    for (const name of stdout.trim().split('\n').filter(Boolean)) {
      entries.set(name, new Uint8Array(await readFile(join(out, name))));
    }
    return entries;
  });
}

/** Joins streamed chunks into the finished archive. */
export function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Pseudo-random but deterministic, so a CRC mistake cannot hide in zeros. */
export function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}
