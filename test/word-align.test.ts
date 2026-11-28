import { describe, expect, it } from 'vitest';
import { alignTranscript, type TranscriptWord } from '../src/connectors/word-align.js';
import { msAtOffset, offsetAtMs, spineAt, globalOffset, type AudioAlignment } from '../src/models/audio-alignment.js';

// 120 distinct words; the transcript speaks them at 0.5s each, with an
// interjection ("um") and a mispronunciation the book does not have.
const BOOK = Array.from({ length: 120 }, (_, i) => `word${String.fromCharCode(0x61 + (i % 26))}${i}`).join(' ');
const bookWords = BOOK.split(' ');

function transcript(spokenCount = 120): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let ms = 0;
  for (let i = 0; i < spokenCount; i++) {
    if (i === 40) { words.push({ word: 'um', startMs: ms, endMs: ms + 500 }); ms += 500; }
    const text = i === 70 ? 'mangled' : bookWords[i];
    words.push({ word: text, startMs: ms, endMs: ms + 500 });
    ms += 500;
  }
  return words;
}

describe('alignTranscript', () => {
  it('anchors real words and interpolates over ASR noise', () => {
    const alignment = alignTranscript(BOOK, transcript());
    expect(alignment.coverage).toBeGreaterThan(0.7);
    const spoken = transcript();

    // Anchor word 10 maps to its own spoken start, not to its index fraction.
    const offset10 = Array.from(bookWords.slice(0, 10).join(' ')).length + 1;
    expect(msAtOffset(alignment, offset10)).toBeCloseTo(spoken[10].startMs, -2);

    // Around the mispronounced word 70 the linear gap is at most a sentence wide.
    const offset70 = Array.from(bookWords.slice(0, 70).join(' ')).length + 1;
    expect(Math.abs(msAtOffset(alignment, offset70)! - spoken[70].startMs)).toBeLessThan(8_000);
  });

  it('round-trips an audio position back to a character offset', () => {
    const alignment = alignTranscript(BOOK, transcript());
    const offset = Array.from(bookWords.slice(0, 55).join(' ')).length + 1;
    const back = offsetAtMs(alignment, msAtOffset(alignment, offset)!);
    expect(back).not.toBeNull();
    expect(Math.abs(back! - offset)).toBeLessThan(60); // one word either side
  });

  it('tokenizes contractions and punctuation the way the book does', () => {
    // The book side splits on non-alphanumerics ("don't" is two tokens); ASR
    // output arrives with the punctuation attached.
    const book = "Don't stop, well-known author: it's fine now";
    const words = ["Don't", 'stop,', 'well-known', 'author:', "it's", 'fine.', 'now']
      .map((word, i) => ({ word, startMs: i * 500, endMs: i * 500 + 500 }));
    const alignment = alignTranscript(book, words);
    // 10 book tokens, so at most 7 anchors: no punctuation match would be 0.
    expect(alignment.coverage).toBeGreaterThan(0.5);
    expect(msAtOffset(alignment, book.indexOf('fine'))).toBeGreaterThanOrEqual(2_000);
  });

  it('reports zero coverage and a linear fallback when nothing matches', () => {
    const alignment = alignTranscript(BOOK, [
      { word: 'completely', startMs: 0, endMs: 1000 },
      { word: 'unrelated', startMs: 1000, endMs: 2000 },
      { word: 'speech', startMs: 2000, endMs: 3000 },
      { word: 'here', startMs: 3000, endMs: 4000 },
    ]);
    expect(alignment.coverage).toBe(0);
    expect(alignment.samples.length).toBe(2);
    expect(alignment.samples[1][0]).toBe(Array.from(BOOK).length);
  });
});

describe('audio-alignment offsets', () => {
  const alignment: AudioAlignment = {
    durationMs: 10_000,
    spineLengths: [10, 0, 20],
    samples: [[0, 0], [10, 5_000], [30, 10_000]],
    words: 3,
    coverage: 1,
    source: 'test',
  };

  it('maps a global offset into a spine, skipping empty spines', () => {
    expect(spineAt(alignment, 12)).toEqual({ spine: 2, offset: 2 });
    expect(spineAt(alignment, 5)).toEqual({ spine: 0, offset: 5 });
    expect(spineAt(alignment, 999)).toEqual({ spine: 2, offset: 20 });
    expect(globalOffset(alignment, 2, 4)).toBe(14);
  });

  it('interpolates inside a gap and clamps outside the book', () => {
    expect(msAtOffset(alignment, 5)).toBe(2_500);
    expect(msAtOffset(alignment, 1000)).toBe(10_000);
    expect(offsetAtMs(alignment, 7_500)).toBe(20);
    expect(offsetAtMs(alignment, -1)).toBe(0);
  });
});
