import type { DocumentMeta } from './types.js';

/**
 * Shared, connector-agnostic book-matching helpers. Connectors call their own
 * search API, then use scoreCandidate() to rank results against the document's
 * title/author. Pure functions - unit-tested independently of any network.
 */

/** Fold diacritics, lowercase, drop punctuation, collapse whitespace. */
export function normalizeText(s: string): string {
  // Letters and digits in any script: an a-z-only rule reduced "変な家２ ～11の間取り図～" to "2 11".
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // combining marks (accents, kana voicing marks)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A trailing "(Series, Book 2)" style suffix. */
const SERIES_SUFFIX = /\s*\((?:[^)]*\b(?:book|vol|volume|part|no)\b[^)]*)\)\s*$/i;
/** The first separator in a title: a colon, or a spaced hyphen, en or em dash. */
const SEPARATOR = /\s*:\s|\s+[-–—]\s+|\s*—\s/;

/**
 * The ways to read a title. "Foundryside: A Novel" is a title and a subtitle, but
 * "241 - Die drei Fragezeichen", "Book One - The Fellowship" and "Game Changers 6: The Long Game"
 * put the real title after the separator. Nothing here guesses which: `before` and `after`
 * are both kept, and matching scores each reading. `full` is the whole title.
 */
export function titleParts(title: string): { full: string; before: string; after: string } {
  const full = title.replace(SERIES_SUFFIX, '').trim();
  const m = SEPARATOR.exec(full);
  if (!m) return { full, before: full, after: '' };
  return {
    full,
    before: full.slice(0, m.index).trim(),
    after: full.slice(m.index + m[0].length).replace(SERIES_SUFFIX, '').trim(),
  };
}

/** The title before its first separator, without a "(Series, Book 2)" suffix. */
export function coreTitle(title: string): string {
  return titleParts(title).before;
}

/** "Last, First" -> "First Last"; also normalizes. */
export function normalizeAuthor(author: string): string {
  const trimmed = author.trim();
  const comma = trimmed.indexOf(',');
  if (comma > 0 && trimmed.indexOf(',') === trimmed.lastIndexOf(',')) {
    const last = trimmed.slice(0, comma).trim();
    const first = trimmed.slice(comma + 1).trim();
    return normalizeText(`${first} ${last}`);
  }
  return normalizeText(trimmed);
}

/**
 * Derive {title, author} for book matching. The EPUB's own title/author (which
 * the firmware extracts and sends in the progress `metadata` object) is the real
 * signal - this is the primary and expected path.
 *
 * Filename is only a last resort for the rare title-less case (a malformed EPUB
 * whose getTitle() was empty). Note it can't rescue the "no metadata at all"
 * case: filename ships in the same metadata object as title/author, so if we
 * lack title we usually lack filename too. We deliberately do NOT guess
 * "Title - Author" vs "Author - Title" ordering - we drop the separators and let
 * the whole string be a fuzzy search query, which search engines handle fine.
 */
export function extractTitleAuthor(doc: DocumentMeta): { title: string; author: string } | null {
  if (doc.title) {
    return { title: doc.title, author: doc.author ?? '' };
  }
  if (doc.filename) {
    const base = doc.filename.replace(/\.[a-z0-9]+$/i, '').replace(/\s*-\s*/g, ' ').trim();
    return base ? { title: base, author: '' } : null;
  }
  return null;
}

/** Token set overlap (Jaccard) of two normalized strings. */
function tokenOverlap(a: string, b: string): number {
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * How alike two titles are, taking the best of their readings: the parts before the separator
 * ("Foundryside: A Novel" vs "Foundryside"), one title's part after the separator against the
 * other's part before it ("241 - Die drei Fragezeichen" vs "Die drei Fragezeichen"), and the
 * whole titles. Parts after a separator are never compared with each other, and whole titles
 * only when one has no separator, so two books that share only a subtitle ("...: A Novel")
 * don't look alike.
 */
function titleSimilarity(a: string, b: string): number {
  const pa = titleParts(a);
  const pb = titleParts(b);
  const pairs: [string, string][] = [
    [pa.before, pb.before],
    [pa.after, pb.before],
    [pa.before, pb.after],
  ];
  if (!pa.after || !pb.after) pairs.push([pa.full, pb.full]);
  let best = 0;
  for (const [x, y] of pairs) {
    const nx = normalizeText(x);
    const ny = normalizeText(y);
    if (nx && ny) best = Math.max(best, tokenOverlap(nx, ny));
  }
  return best;
}

export interface Candidate {
  externalId: string;
  title: string;
  author?: string | null;
  /** Optional popularity/rank signal (higher = more popular), used as a tiebreak. */
  popularity?: number;
}

export interface ScoredCandidate extends Candidate {
  score: number;
}

/**
 * Score a candidate against the wanted title/author. Title similarity dominates;
 * author overlap is a strong secondary that disambiguates same-title collisions.
 */
export function scoreCandidate(
  wantTitle: string,
  wantAuthor: string,
  cand: Candidate
): number {
  const titleScore = titleSimilarity(wantTitle, cand.title);

  const wa = wantAuthor ? normalizeAuthor(wantAuthor) : '';
  const ca = cand.author ? normalizeAuthor(cand.author) : '';
  const authorScore = wa && ca ? tokenOverlap(wa, ca) : 0;

  // No author info on either side: rely on title alone (capped so it can't
  // clear a high threshold on title-only, since title collisions are common).
  if (!wa || !ca) return titleScore * 0.85;
  return titleScore * 0.7 + authorScore * 0.3;
}

export interface MatchDecision {
  best: ScoredCandidate | null;
  accepted: boolean;
}

/**
 * Rank candidates and decide whether to auto-accept: the top must clear
 * `threshold` AND beat the runner-up by `margin` (unless the runner-up is the
 * same book - same normalized title+author - in which case ambiguity between
 * editions is fine and we take the more popular one).
 */
export function decideMatch(
  wantTitle: string,
  wantAuthor: string,
  candidates: Candidate[],
  opts: { threshold?: number; margin?: number } = {}
): MatchDecision {
  const threshold = opts.threshold ?? 0.6;
  const margin = opts.margin ?? 0.15;
  if (candidates.length === 0) return { best: null, accepted: false };

  const scored: ScoredCandidate[] = candidates
    .map((c) => ({ ...c, score: scoreCandidate(wantTitle, wantAuthor, c) }))
    .sort((a, b) => b.score - a.score || (b.popularity ?? 0) - (a.popularity ?? 0));

  const best = scored[0];
  if (best.score < threshold) return { best, accepted: false };

  const runner = scored[1];
  if (!runner) return { best, accepted: true };

  const sameBook =
    normalizeText(coreTitle(best.title)) === normalizeText(coreTitle(runner.title)) &&
    normalizeAuthor(best.author ?? '') === normalizeAuthor(runner.author ?? '');
  if (sameBook) return { best, accepted: true };

  return { best, accepted: best.score - runner.score >= margin };
}
