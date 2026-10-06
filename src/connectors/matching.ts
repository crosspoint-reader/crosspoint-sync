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

/** Strip subtitle after a colon and trailing "(Series, Book 2)" style suffixes. */
export function coreTitle(title: string): string {
  let t = title.replace(/\s*[:—-]\s.*$/, ''); // subtitle
  t = t.replace(/\s*\((?:[^)]*\b(?:book|vol|volume|part|no)\b[^)]*)\)\s*$/i, '');
  return t.trim();
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
  const wt = normalizeText(coreTitle(wantTitle));
  const ct = normalizeText(coreTitle(cand.title));
  const titleScore = wt && ct ? tokenOverlap(wt, ct) : 0;

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
