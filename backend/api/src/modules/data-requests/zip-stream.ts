import { once } from 'node:events';
import { createDeflateRaw } from 'node:zlib';

/**
 * A streaming zip writer for the D6 data export (QA-081): entries go out as they are read,
 * deflated, with the sizes and CRC in a data descriptor after each one (general-purpose
 * flag bit 3), so nothing — not one file, not the archive — is ever held in memory.
 *
 * Hand-written on `node:zlib` rather than a library: `jszip` is only a dev dependency of
 * the API (the production image is `pnpm deploy --prod`), and it buffers an entry unless
 * it is given a Node stream. No zip64: every section of the export is capped far below
 * 4 GiB and 65 535 entries, and a writer that would overflow throws instead of writing a
 * corrupt archive.
 */
export interface ZipEntry {
  /** Path inside the archive, `/`-separated. Written as UTF-8 (flag bit 11). */
  name: string;
  /** Read lazily, when the writer reaches this entry. */
  content: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>;
}

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const VERSION = 20;
/** Bit 3: sizes and CRC follow the data. Bit 11: the name is UTF-8. */
const FLAGS = 0x0808;
const DEFLATE = 8;
const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE), continued from `crc` — the zip checksum. */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = (crc ^ MAX_U32) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ MAX_U32) >>> 0;
}

/** MS-DOS date and time, local fields read in UTC so an archive does not depend on the server's zone. */
export function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

export async function* zipStream(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>, modified: Date = new Date()): AsyncGenerator<Buffer> {
  const { time, date } = dosDateTime(modified);
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;

  for await (const entry of entries) {
    if (++count > MAX_ENTRIES) throw new Error('zip: too many entries');
    const name = Buffer.from(entry.name, 'utf8');
    const headerOffset = offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    // CRC and sizes (14–25) stay zero: they are in the data descriptor.
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    yield local;
    yield name;
    offset += local.length + name.length;

    let crc = 0;
    let size = 0;
    let compressed = 0;
    const deflate = createDeflateRaw();
    // The content is fed on its own task while this one drains the deflater, so a slow
    // reader (the HTTP client) pauses the database reads through the deflater's buffer.
    const feed = (async () => {
      try {
        for await (const chunk of entry.content) {
          const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          if (!bytes.length) continue;
          crc = crc32(bytes, crc);
          size += bytes.length;
          if (!deflate.write(bytes)) await once(deflate, 'drain');
        }
        deflate.end();
      } catch (error) {
        deflate.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    })();
    try {
      for await (const out of deflate as AsyncIterable<Buffer>) {
        compressed += out.length;
        offset += out.length;
        yield out;
      }
    } finally {
      // A consumer that stopped reading (a closed download) ends here; the feed is left
      // waiting on a stream that will never drain and is collected with it.
      deflate.destroy();
    }
    await feed;
    if (size > MAX_U32 || compressed > MAX_U32 || offset > MAX_U32) throw new Error('zip: entry too large for a non-zip64 archive');

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor;
    offset += descriptor.length;

    const header = Buffer.alloc(46);
    header.writeUInt32LE(SIG_CENTRAL, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(VERSION, 6);
    header.writeUInt16LE(FLAGS, 8);
    header.writeUInt16LE(DEFLATE, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    // Extra (30), comment (32), disk (34), internal (36), external (38) attributes: zero.
    header.writeUInt32LE(headerOffset, 42);
    central.push(header, name);
  }

  const directoryOffset = offset;
  let directorySize = 0;
  for (const part of central) {
    directorySize += part.length;
    yield part;
  }
  if (directoryOffset + directorySize > MAX_U32) throw new Error('zip: archive too large for a non-zip64 archive');

  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(directoryOffset, 16);
  yield end;
}
