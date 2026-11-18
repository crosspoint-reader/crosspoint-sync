import { gunzipSync, gzipSync } from 'node:zlib';
import type { DB } from '../db/db.js';

/**
 * A book's audio alignment: sample points mapping a character offset in the
 * concatenated EPUB spine text to a millisecond in the audiobook. Positions
 * between samples interpolate linearly, which is exact enough because samples
 * come from ASR-matched words (usually one every sentence or two).
 *
 * Offsets are UTF-16 code units, i.e. plain JS string indices, so they line up
 * with `spineBases` built from `String#length`. XPath conversion is the only
 * place that has to think in codepoints.
 */
export interface AudioAlignment {
  durationMs: number;
  /** Length of each spine item's text, in order. */
  spineLengths: number[];
  /** [charOffset, ms] ascending. */
  samples: [number, number][];
  words: number;
  /** Matched words / book words; low coverage means a weak or partial alignment. */
  coverage: number;
  source: string;
}

interface Row {
  duration_ms: number;
  samples: Uint8Array;
  spines: Uint8Array;
  words: number;
  coverage: number;
  source: string;
}

export function saveAlignment(
  db: DB,
  userId: number,
  connectorId: string,
  externalId: string,
  document: string,
  a: AudioAlignment
): void {
  db.prepare(
    `INSERT INTO audio_alignment
       (user_id, connector_id, external_id, document, duration_ms, samples, spines, words, coverage, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, connector_id, external_id) DO UPDATE SET
       document = excluded.document, duration_ms = excluded.duration_ms, samples = excluded.samples,
       spines = excluded.spines, words = excluded.words, coverage = excluded.coverage,
       source = excluded.source, created_at = excluded.created_at`
  ).run(
    userId, connectorId, externalId, document, Math.round(a.durationMs),
    gzipSync(JSON.stringify(a.samples)), gzipSync(JSON.stringify(a.spineLengths)),
    a.words, a.coverage, a.source, Math.floor(Date.now() / 1000)
  );
}

export function loadAlignment(
  db: DB, userId: number, connectorId: string, externalId: string
): AudioAlignment | null {
  const row = db.prepare(
    'SELECT duration_ms, samples, spines, words, coverage, source FROM audio_alignment WHERE user_id = ? AND connector_id = ? AND external_id = ?'
  ).get(userId, connectorId, externalId) as Row | undefined;
  if (!row) return null;
  try {
    return {
      durationMs: row.duration_ms,
      samples: JSON.parse(gunzipSync(row.samples).toString()) as [number, number][],
      spineLengths: JSON.parse(gunzipSync(row.spines).toString()) as number[],
      words: row.words,
      coverage: row.coverage,
      source: row.source,
    };
  } catch {
    return null; // Corrupt row: behave as unaligned rather than break sync.
  }
}

/** Index of the last sample at or below `value` on one axis (0 = chars, 1 = ms). */
function before(samples: [number, number][], value: number, axis: 0 | 1): number {
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid][axis] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Interpolate `value` (on `axis`) between the bracketing samples; clamps at the ends. */
function interpolate(a: AudioAlignment, value: number, axis: 0 | 1): number {
  const i = before(a.samples, value, axis);
  const [lo, hi] = [a.samples[i], a.samples[i + 1]];
  const other = (1 - axis) as 0 | 1;
  if (!hi || hi[axis] === lo[axis]) return lo[other];
  return lo[other] + ((value - lo[axis]) / (hi[axis] - lo[axis])) * (hi[other] - lo[other]);
}

/** Audio time (ms) at a character offset. */
export function msAtOffset(a: AudioAlignment, offset: number): number | null {
  if (!a.samples.length) return null;
  return Math.max(0, Math.min(a.durationMs, Math.round(interpolate(a, offset, 0))));
}

/** Character offset at an audio time (ms). */
export function offsetAtMs(a: AudioAlignment, ms: number): number | null {
  if (!a.samples.length) return null;
  const total = a.samples[a.samples.length - 1][0];
  return Math.max(0, Math.min(total, Math.round(interpolate(a, ms, 1))));
}

/** Spine index and offset within it, from a global character offset. */
export function spineAt(a: AudioAlignment, offset: number): { spine: number; offset: number } {
  let base = 0;
  for (const [index, length] of a.spineLengths.entries()) {
    if (offset < base + length) return { spine: index, offset: offset - base };
    base += length;
  }
  const spine = Math.max(0, a.spineLengths.length - 1);
  return { spine, offset: Math.max(0, a.spineLengths[spine] ?? 0) };
}

/** Global character offset of a spine-local offset. */
export function globalOffset(a: AudioAlignment, spine: number, offset: number): number {
  const base = a.spineLengths.slice(0, Math.max(0, spine)).reduce((sum, n) => sum + n, 0);
  return base + Math.max(0, Math.min(a.spineLengths[spine] ?? 0, offset));
}
