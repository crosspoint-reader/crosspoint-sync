import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

/**
 * Serves the CrossPoint Kindle Link extension as a zip, built from the
 * extension/ directory at the repo/image root. Store-only (no compression):
 * these are small text files, and a dependency-free writer keeps the image lean.
 * Deterministic (fixed timestamp) so the buffer can be cached for the process.
 */

const EXT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const EXT_FILES = ['manifest.json', 'background.js', 'lib.mjs', 'popup.html', 'popup.js'];

// Fixed DOS date (2026-01-01) for reproducible archives.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Minimal store-only ZIP archive (local headers + central directory + EOCD). */
export function buildZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(e.data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(DOS_DATE, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18); // compressed size
    local.writeUInt32LE(e.data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    chunks.push(local, name, e.data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // central directory signature
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0, 8); // flags
    cen.writeUInt16LE(0, 10); // method
    cen.writeUInt16LE(0, 12); // time
    cen.writeUInt16LE(DOS_DATE, 14); // date
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(e.data.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30); // extra length
    cen.writeUInt16LE(0, 32); // comment length
    cen.writeUInt16LE(0, 34); // disk number
    cen.writeUInt16LE(0, 36); // internal attributes
    cen.writeUInt32LE(0, 38); // external attributes
    cen.writeUInt32LE(offset, 42); // local header offset
    central.push(cen, name);

    offset += local.length + name.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16); // central directory offset
  return Buffer.concat([...chunks, cd, eocd]);
}

let cached: Buffer | null = null;

/** The extension zip, built once per process. Null when extension/ is absent. */
export function extensionZip(): Buffer | null {
  if (cached) return cached;
  try {
    const entries = EXT_FILES.map((name) => ({
      name,
      data: fs.readFileSync(path.join(EXT_DIR, name)),
    }));
    cached = buildZip(entries);
    return cached;
  } catch {
    return null;
  }
}
