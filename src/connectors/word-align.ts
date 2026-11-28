import type { AudioAlignment } from '../models/audio-alignment.js';

export interface TranscriptWord {
  word: string;
  startMs: number;
  endMs: number;
}

interface Token {
  text: string;
  /** Codepoint offset of the token in the book text. */
  offset: number;
}

const WORD = /[\p{L}\p{N}]+/gu;
const ANCHOR = 4;

/** Accents, case and punctuation differ between a book and an ASR transcript. */
function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

function bookTokens(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  let codepoint = 0;
  for (const match of text.matchAll(WORD)) {
    codepoint += Array.from(text.slice(at, match.index)).length;
    at = match.index;
    const word = normalize(match[0]);
    if (word) tokens.push({ text: word, offset: codepoint });
    codepoint += Array.from(match[0]).length;
    at += match[0].length;
  }
  return tokens;
}

function key(tokens: string[], index: number): string {
  return tokens.slice(index, index + ANCHOR).join(' ');
}

interface Pair { book: number; transcript: number }

/** Longest chain where both the book and the transcript index increase. */
function longestChain(pairs: Pair[]): Pair[] {
  const tails: number[] = []; // tails[k] = index into pairs of the smallest tail of a chain of length k+1
  const previous = new Array<number>(pairs.length).fill(-1);
  for (const [index, pair] of pairs.entries()) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]].transcript < pair.transcript) lo = mid + 1;
      else hi = mid;
    }
    previous[index] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = index;
  }
  const chain: Pair[] = [];
  for (let at = tails.length ? tails[tails.length - 1] : -1; at >= 0; at = previous[at]) chain.unshift(pairs[at]);
  return chain;
}

/**
 * Align a book's text with an ASR transcript by anchoring on unique 4-word
 * sequences, keeping the longest chain that runs forward in both, and
 * interpolating linearly between neighbouring anchors.
 *
 * No dynamic programming: a handful of anchors per chapter pins the mapping
 * tightly enough that the linear gaps stay within a sentence, and the chain
 * ignores the transcription errors and narrator additions that a full edit
 * distance alignment would have to pay for.
 */
export function alignTranscript(bookText: string, words: TranscriptWord[]): AudioAlignment {
  const tokens = bookTokens(bookText);
  // Same tokenizer as the book: ASR output carries punctuation and contractions
  // ("don't", " Hello,"), and each spoken token keeps its word so timestamps
  // stay on the right word when one ASR word yields none.
  const spoken: string[] = [];
  const spokenWord: number[] = [];
  for (const [index, word] of words.entries()) {
    for (const match of word.word.matchAll(WORD)) {
      const token = normalize(match[0]);
      if (token) { spoken.push(token); spokenWord.push(index); }
    }
  }
  const samples: [number, number][] = [];
  let anchors = 0;

  if (tokens.length >= ANCHOR && spoken.length >= ANCHOR) {
    const keys = tokens.map(t => t.text);
    // Unique transcript 4-grams only: repeated phrases would anchor the wrong place.
    const owner = new Map<string, number>();
    for (let index = 0; index + ANCHOR <= spoken.length; index++) {
      const phrase = key(spoken, index);
      owner.set(phrase, owner.has(phrase) ? -1 : index);
    }
    const pairs: Pair[] = [];
    for (let index = 0; index + ANCHOR <= keys.length; index++) {
      const at = owner.get(key(keys, index));
      if (at !== undefined && at >= 0) pairs.push({ book: index, transcript: at });
    }
    const chain = longestChain(pairs);
    anchors = chain.length;
    for (const pair of chain) {
      const start = words[spokenWord[pair.transcript]].startMs;
      const last = samples[samples.length - 1];
      const offset = tokens[pair.book].offset;
      if (last && (start <= last[1] || offset <= last[0])) continue;
      samples.push([offset, start]);
    }
  }

  const end = Array.from(bookText).length;
  const total = words.length ? words[words.length - 1].endMs : 0;
  if (!samples.length) {
    // Nothing matched (wrong book, no speech): a linear map is still better than none,
    // but coverage reports 0 so callers can warn.
    if (end > 0 && total > 0) samples.push([0, 0], [end, total]);
  } else {
    if (samples[0][0] > 0) samples.unshift([0, samples[0][1]]);
    const last = samples[samples.length - 1];
    if (last[0] < end && total > last[1]) samples.push([end, total]);
  }

  return {
    durationMs: total,
    spineLengths: [],
    samples,
    words: tokens.length,
    coverage: tokens.length ? anchors / tokens.length : 0,
    source: '',
  };
}
