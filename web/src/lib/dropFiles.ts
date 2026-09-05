/**
 * Extracts files from a drag-and-drop DataTransfer, including the contents
 * of dropped folders (recursive directory traversal via the entries API,
 * capped so a stray drop of a huge tree can't hang the page).
 */

const MAX_FILES = 2000;

interface FSEntry {
  isFile: boolean;
  isDirectory: boolean;
  file(cb: (f: File) => void, err?: (e: unknown) => void): void;
  createReader(): {
    readEntries(cb: (entries: FSEntry[]) => void, err?: (e: unknown) => void): void;
  };
}

function readAllEntries(reader: ReturnType<FSEntry['createReader']>): Promise<FSEntry[]> {
  // readEntries returns results in batches of ~100; keep calling until empty.
  return new Promise((resolve) => {
    const all: FSEntry[] = [];
    const step = () =>
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) return resolve(all);
          all.push(...batch);
          step();
        },
        () => resolve(all),
      );
    step();
  });
}

async function collect(entry: FSEntry, out: File[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) =>
      entry.file(
        (f) => resolve(f),
        () => resolve(null),
      ),
    );
    if (file) out.push(file);
  } else if (entry.isDirectory) {
    const children = await readAllEntries(entry.createReader());
    for (const child of children) {
      if (out.length >= MAX_FILES) return;
      await collect(child, out);
    }
  }
}

export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = items
    .map((i) => (typeof i.webkitGetAsEntry === 'function' ? (i.webkitGetAsEntry() as FSEntry | null) : null))
    .filter((e): e is FSEntry => e !== null);

  if (entries.length > 0) {
    const out: File[] = [];
    for (const entry of entries) {
      if (out.length >= MAX_FILES) break;
      await collect(entry, out);
    }
    if (out.length > 0) return out;
  }
  // Fallback for browsers without the entries API.
  return Array.from(dt.files);
}
