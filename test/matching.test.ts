import { describe, expect, it } from 'vitest';
import {
  coreTitle,
  decideMatch,
  extractTitleAuthor,
  normalizeAuthor,
  scoreCandidate,
  titleParts,
} from '../src/connectors/matching.js';

describe('matching helpers', () => {
  it('strips subtitles and series suffixes from titles', () => {
    expect(coreTitle('Foundryside: A Novel')).toBe('Foundryside');
    expect(coreTitle('Foundryside (The Founders Trilogy, Book 1)')).toBe('Foundryside');
    expect(coreTitle('Plain Title')).toBe('Plain Title');
  });

  it('keeps both sides of a title separator', () => {
    expect(titleParts('241 - Die drei Fragezeichen und das weiße Auge')).toEqual({
      full: '241 - Die drei Fragezeichen und das weiße Auge',
      before: '241',
      after: 'Die drei Fragezeichen und das weiße Auge',
    });
    expect(titleParts('Book One – The Fellowship of the Ring')).toMatchObject({ before: 'Book One', after: 'The Fellowship of the Ring' });
    expect(titleParts('1984: A Novel')).toMatchObject({ before: '1984', after: 'A Novel' });
    expect(titleParts('Catch-22')).toEqual({ full: 'Catch-22', before: 'Catch-22', after: '' });
    expect(titleParts('Foundryside (The Founders Trilogy, Book 1)')).toEqual({ full: 'Foundryside', before: 'Foundryside', after: '' });
  });

  it('matches a title on whichever side of the separator is the real title', () => {
    const score = (want: string, cand: string, author = 'A') => scoreCandidate(want, author, { externalId: '1', title: cand, author });
    // Series number or prefix first.
    expect(score('241 - Die drei Fragezeichen und das weiße Auge', 'Die drei Fragezeichen und das weiße Auge')).toBeGreaterThan(0.9);
    expect(score('Book One - The Fellowship of the Ring', 'The Fellowship of the Ring')).toBeGreaterThan(0.9);
    expect(score('Game Changers 6: The Long Game', 'The Long Game')).toBeGreaterThan(0.9);
    // Subtitle second.
    expect(score('1984: A Novel', '1984')).toBeGreaterThan(0.9);
    expect(score('1984 - A Novel', '1984')).toBeGreaterThan(0.9);
    expect(score('Foundryside: A Novel', 'Foundryside')).toBeGreaterThan(0.9);
    expect(score('Foundryside', 'Foundryside: A Novel')).toBeGreaterThan(0.9);
    // A shared subtitle alone isn't a match.
    expect(score('Beach Read: A Novel', 'Book Lovers: A Novel')).toBeLessThan(0.6);
  });

  it('picks the right book of a numbered series, not another by the same author', () => {
    const want = '241 - Die drei Fragezeichen und das weiße Auge';
    const decision = decideMatch(want, 'Marco Sonnleitner', [
      { externalId: 'other', title: 'Die drei Fragezeichen und der Fluch des Rubins', author: 'Marco Sonnleitner' },
      { externalId: 'right', title: 'Die drei Fragezeichen und das weiße Auge', author: 'Marco Sonnleitner' },
    ]);
    expect(decision.accepted).toBe(true);
    expect(decision.best?.externalId).toBe('right');
  });

  it('normalizes "Last, First" author form', () => {
    expect(normalizeAuthor('Bennett, Robert Jackson')).toBe('robert jackson bennett');
    expect(normalizeAuthor('Robert Jackson Bennett')).toBe('robert jackson bennett');
  });

  it('uses EPUB title/author as the primary signal', () => {
    expect(extractTitleAuthor({ document: 'd', title: 'Foundryside', author: 'RJB', filename: 'x.epub' }))
      .toEqual({ title: 'Foundryside', author: 'RJB' });
  });

  it('falls back to a filename query only when title is missing, without guessing order', () => {
    expect(
      extractTitleAuthor({
        document: 'd',
        title: null,
        author: null,
        filename: 'Foundryside - Robert Jackson Bennett.epub',
      })
    ).toEqual({ title: 'Foundryside Robert Jackson Bennett', author: '' });
    expect(extractTitleAuthor({ document: 'd', title: null, author: null, filename: null })).toBeNull();
  });

  it('scores exact title+author near 1 and mismatches low', () => {
    const good = scoreCandidate('Foundryside', 'Robert Jackson Bennett', {
      externalId: '1',
      title: 'Foundryside',
      author: 'Robert Jackson Bennett',
    });
    expect(good).toBeGreaterThan(0.9);
    const bad = scoreCandidate('Foundryside', 'Robert Jackson Bennett', {
      externalId: '2',
      title: 'Dune',
      author: 'Frank Herbert',
    });
    expect(bad).toBeLessThan(0.2);
  });

  it('auto-accepts a clear winner, rejects ambiguous title collisions', () => {
    const clear = decideMatch('Foundryside', 'Robert Jackson Bennett', [
      { externalId: '1', title: 'Foundryside', author: 'Robert Jackson Bennett' },
      { externalId: '2', title: 'Dune', author: 'Frank Herbert' },
    ]);
    expect(clear.accepted).toBe(true);
    expect(clear.best?.externalId).toBe('1');

    // Two different books literally titled "Circe" — needs author to split; with
    // no author on the query, stays unaccepted.
    const collision = decideMatch('Circe', '', [
      { externalId: '1', title: 'Circe', author: 'Madeline Miller' },
      { externalId: '2', title: 'Circe', author: 'Someone Else' },
    ]);
    expect(collision.accepted).toBe(false);
  });

  it('accepts same-book different-edition ambiguity, taking the popular one', () => {
    const d = decideMatch('Foundryside', 'Robert Jackson Bennett', [
      { externalId: 'ed1', title: 'Foundryside', author: 'Robert Jackson Bennett', popularity: 10 },
      { externalId: 'ed2', title: 'Foundryside', author: 'Robert Jackson Bennett', popularity: 500 },
    ]);
    expect(d.accepted).toBe(true);
    expect(d.best?.externalId).toBe('ed2');
  });

  it('returns unaccepted for empty candidates', () => {
    expect(decideMatch('X', 'Y', []).accepted).toBe(false);
  });
});
