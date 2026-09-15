/**
 * A streaming ZIP writer.
 *
 * Why hand-rolled: the whole point of this app is that bytes go browser ↔ R2
 * and are never held in memory, so the archive has to be produced as a stream
 * of chunks that can be piped straight to disk. Entries are stored, never
 * deflated — the payload is video and JPEG, which does not compress, so
 * deflating would only burn CPU on the editor's machine.
 *
 * Because the data is streamed, the CRC and the real size of an entry are only
 * known after its bytes have gone past. Entries therefore use a data descriptor
 * (general-purpose flag bit 3) and the sizes in the local header are zero.
 *
 * ZIP64 is used per entry, only where it is actually needed (an entry of 4 GB
 * or more, or one starting past the 4 GB mark). A zip of a few phone photos
 * stays a plain ZIP that even the oldest tool opens.
 */

const LOCAL_SIG = 0x04034b50;
const DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;

/** Anything at or above this cannot be expressed in a 32-bit ZIP field. */
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

/** Data descriptor present + names are UTF-8. */
const FLAGS = 0x0008 | 0x0800;
const METHOD_STORE = 0;
const VERSION_PLAIN = 20;
const VERSION_ZIP64 = 45;

/**
 * "Version made by" carries the host system in its high byte. It has to say
 * Unix (3) rather than MS-DOS (0): readers that predate the UTF-8 flag — the
 * `unzip` shipped with macOS among them — fall back to the host byte, and on
 * MS-DOS they transliterate the name from code page 437, which corrupts every
 * non-ASCII filename and can fail the extraction outright.
 */
const HOST_UNIX = 3 << 8;
/** Regular file, rw-r--r--, in the Unix half of the external attributes. */
const EXTERNAL_ATTRS_FILE = 0o100644 << 16;

const encoder = new TextEncoder();

const CRC_TABLE = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32 of `buf`, continuing from `previous` so a value can be accumulated
 * across the chunks of a streamed file.
 */
export function crc32(buf: Uint8Array, previous = 0): number {
  let c = ~previous >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return ~c >>> 0;
}

/** Little-endian fixed-size record builder. */
class Record {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private pos = 0;

  constructor(length: number) {
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }

  u16(value: number): this {
    this.view.setUint16(this.pos, value, true);
    this.pos += 2;
    return this;
  }

  u32(value: number): this {
    this.view.setUint32(this.pos, value >>> 0, true);
    this.pos += 4;
    return this;
  }

  u64(value: number): this {
    this.view.setBigUint64(this.pos, BigInt(value), true);
    this.pos += 8;
    return this;
  }

  raw(value: Uint8Array): this {
    this.bytes.set(value, this.pos);
    this.pos += value.length;
    return this;
  }

  done(): Uint8Array {
    if (this.pos !== this.bytes.length) {
      throw new Error(`ZIP record is ${this.pos} bytes, declared ${this.bytes.length}`);
    }
    return this.bytes;
  }
}

/** MS-DOS timestamp; the format cannot represent anything before 1980. */
function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Makes a display name safe to use as a ZIP entry name: everything lands flat
 * in the archive, so separators become underscores and any `.`/`..` segment is
 * dropped rather than letting an entry escape the extraction directory.
 */
export function zipEntryName(name: string): string {
  const flat = name
    .split(/[\\/]+/)
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .join('_')
    .trim();
  return flat === '' ? 'file' : flat;
}

/**
 * Picks a name not already in `used` (and records it), so two files that share
 * a display name do not collide inside the archive.
 */
export function uniqueEntryName(used: Set<string>, desired: string): string {
  const base = zipEntryName(desired);
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) {
    const dot = base.lastIndexOf('.');
    name = dot > 0 ? `${base.slice(0, dot)} (${i})${base.slice(dot)}` : `${base} (${i})`;
  }
  used.add(name.toLowerCase());
  return name;
}

export interface ZipEntry {
  name: string;
  /** Exact byte length, known before streaming; decides ZIP64 for this entry. */
  size: number;
  lastModified?: number;
}

interface CentralEntry {
  name: Uint8Array;
  time: number;
  date: number;
  crc: number;
  size: number;
  offset: number;
  zip64: boolean;
}

export interface ZipWriterOptions {
  /**
   * Size (and offset) at which an entry switches to ZIP64. Only ever lowered
   * by the tests, so the 64-bit path can be exercised without producing four
   * gigabytes of output.
   */
  zip64Threshold?: number;
}

export class ZipWriter {
  private offset = 0;
  private readonly central: CentralEntry[] = [];
  private open: (CentralEntry & { declaredSize: number }) | null = null;
  private finished = false;
  private readonly zip64Threshold: number;

  constructor(
    private readonly sink: (chunk: Uint8Array) => Promise<void>,
    options: ZipWriterOptions = {},
  ) {
    this.zip64Threshold = options.zip64Threshold ?? U32_MAX;
  }

  /** Bytes of archive produced so far. */
  get bytesWritten(): number {
    return this.offset;
  }

  /** Payload bytes of the entry currently open — where a retry must resume. */
  get entryBytesWritten(): number {
    return this.open?.size ?? 0;
  }

  async beginFile(entry: ZipEntry): Promise<void> {
    if (this.open) throw new Error('A ZIP entry is already open');
    if (this.finished) throw new Error('This ZIP is already finished');
    if (!Number.isInteger(entry.size) || entry.size < 0) {
      throw new Error(`Invalid size for “${entry.name}”`);
    }

    const name = encoder.encode(entry.name);
    const { time, date } = dosDateTime(entry.lastModified ?? Date.now());
    // The offset is part of the decision: an entry that starts past 4 GB needs
    // a 64-bit relative offset in the central directory regardless of its size.
    const zip64 = entry.size >= this.zip64Threshold || this.offset >= this.zip64Threshold;

    const extraLength = zip64 ? 20 : 0;
    const header = new Record(30 + name.length + extraLength)
      .u32(LOCAL_SIG)
      .u16(zip64 ? VERSION_ZIP64 : VERSION_PLAIN)
      .u16(FLAGS)
      .u16(METHOD_STORE)
      .u16(time)
      .u16(date)
      .u32(0) // crc — in the data descriptor
      .u32(0) // compressed size — in the data descriptor
      .u32(0) // uncompressed size — in the data descriptor
      .u16(name.length)
      .u16(extraLength)
      .raw(name);
    if (zip64) {
      header.u16(ZIP64_EXTRA_ID).u16(16).u64(0).u64(0);
    }

    this.open = { name, time, date, crc: 0, size: 0, offset: this.offset, zip64, declaredSize: entry.size };
    await this.emit(header.done());
  }

  /** Appends payload bytes to the open entry. */
  async write(chunk: Uint8Array): Promise<void> {
    const open = this.open;
    if (!open) throw new Error('No ZIP entry is open');
    if (chunk.length === 0) return;
    if (open.size + chunk.length > open.declaredSize) {
      // The ZIP64 decision was made from the declared size, so a file that
      // turns out bigger would produce an archive with unreadable offsets.
      throw new Error(`“${decodeName(open.name)}” is larger than its recorded size`);
    }
    open.crc = crc32(chunk, open.crc);
    open.size += chunk.length;
    await this.emit(chunk);
  }

  async endFile(): Promise<void> {
    const open = this.open;
    if (!open) throw new Error('No ZIP entry is open');
    if (open.size !== open.declaredSize) {
      throw new Error(
        `“${decodeName(open.name)}” is ${open.size} bytes, expected ${open.declaredSize}`,
      );
    }
    const descriptor = open.zip64
      ? new Record(24).u32(DESCRIPTOR_SIG).u32(open.crc).u64(open.size).u64(open.size)
      : new Record(16).u32(DESCRIPTOR_SIG).u32(open.crc).u32(open.size).u32(open.size);
    this.open = null;
    this.central.push(open);
    await this.emit(descriptor.done());
  }

  /** Writes the central directory and end-of-archive records. */
  async finish(): Promise<void> {
    if (this.open) throw new Error('A ZIP entry is still open');
    if (this.finished) return;
    this.finished = true;

    const centralOffset = this.offset;
    for (const e of this.central) {
      const extraLength = e.zip64 ? 28 : 0;
      const record = new Record(46 + e.name.length + extraLength)
        .u32(CENTRAL_SIG)
        .u16(HOST_UNIX | (e.zip64 ? VERSION_ZIP64 : VERSION_PLAIN)) // version made by
        .u16(e.zip64 ? VERSION_ZIP64 : VERSION_PLAIN) // version needed
        .u16(FLAGS)
        .u16(METHOD_STORE)
        .u16(e.time)
        .u16(e.date)
        .u32(e.crc)
        .u32(e.zip64 ? U32_MAX : e.size)
        .u32(e.zip64 ? U32_MAX : e.size)
        .u16(e.name.length)
        .u16(extraLength)
        .u16(0) // comment length
        .u16(0) // disk number
        .u16(0) // internal attributes
        .u32(EXTERNAL_ATTRS_FILE)
        .u32(e.zip64 ? U32_MAX : e.offset)
        .raw(e.name);
      if (e.zip64) {
        // Order is fixed by the spec: uncompressed, compressed, offset.
        record.u16(ZIP64_EXTRA_ID).u16(24).u64(e.size).u64(e.size).u64(e.offset);
      }
      await this.emit(record.done());
    }

    const centralSize = this.offset - centralOffset;
    const count = this.central.length;
    const needsZip64 =
      count > U16_MAX ||
      centralSize >= this.zip64Threshold ||
      centralOffset >= this.zip64Threshold ||
      this.central.some((e) => e.zip64);

    if (needsZip64) {
      const zip64Eocd = new Record(56)
        .u32(ZIP64_EOCD_SIG)
        .u64(44) // size of the rest of this record
        .u16(HOST_UNIX | VERSION_ZIP64)
        .u16(VERSION_ZIP64)
        .u32(0) // this disk
        .u32(0) // disk with the central directory
        .u64(count)
        .u64(count)
        .u64(centralSize)
        .u64(centralOffset)
        .done();
      await this.emit(zip64Eocd);
      const locator = new Record(20)
        .u32(ZIP64_LOCATOR_SIG)
        .u32(0)
        .u64(this.offset - 56)
        .u32(1)
        .done();
      await this.emit(locator);
    }

    const eocd = new Record(22)
      .u32(EOCD_SIG)
      .u16(0)
      .u16(0)
      .u16(Math.min(count, U16_MAX))
      .u16(Math.min(count, U16_MAX))
      .u32(Math.min(centralSize, U32_MAX))
      .u32(Math.min(centralOffset, U32_MAX))
      .u16(0)
      .done();
    await this.emit(eocd);
  }

  private async emit(chunk: Uint8Array): Promise<void> {
    this.offset += chunk.length;
    await this.sink(chunk);
  }
}

function decodeName(name: Uint8Array): string {
  return new TextDecoder().decode(name);
}
