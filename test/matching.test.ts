import { describe, expect, it } from 'vitest';
import {
  coreTitle,
  decideMatch,
  extractTitleAuthor,
  normalizeAuthor,
  scoreCandidate,
} from '../src/connectors/matching.js';

describe('matching helpers', () => {
  it('strips subtitles and series suffixes from titles', () => {
    expect(coreTitle('Foundryside: A Novel')).toBe('Foundryside');
    expect(coreTitle('Foundryside (The Founders Trilogy, Book 1)')).toBe('Foundryside');
    expect(coreTitle('Plain Title')).toBe('Plain Title');
  });

  it('drops a leading series number before the subtitle cut', () => {
    expect(coreTitle('241 - Die drei Fragezeichen und das weiße Auge')).toBe('Die drei Fragezeichen und das weiße Auge');
    expect(coreTitle('03 – The Way of Kings: Part One')).toBe('The Way of Kings');
    expect(coreTitle('1984')).toBe('1984');
    expect(coreTitle('1984: A Novel')).toBe('1984');
    expect(coreTitle('2001 - ')).toBe('2001'); // nothing after the dash: the number is the title
  });

  it('matches a numbered title against the same book without the number', () => {
    const cand = { externalId: 'x', title: 'Die drei ??? und das weiße Auge (drei Fragezeichen)', author: 'Marco Sonnleitner' };
    expect(scoreCandidate('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner', cand)).toBeGreaterThanOrEqual(0.6);
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
