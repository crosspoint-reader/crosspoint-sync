import { describe, expect, it } from 'vitest';
import jpeg from 'jpeg-js';
import yauzl from 'yauzl';
import type { HttpTransport } from '../src/connectors/types.js';
import { extractArticle } from '../src/models/newspaper.js';
import { renderCover } from '../src/render/crosspaper-cover.js';
import { isPublicAddress, safeFetch } from '../src/safe-fetch.js';
import { makeTestApp, registerUser } from './helpers.js';

const para = 'The quick brown fox jumps over the lazy dog and keeps running through the field. '.repeat(6);
const articlePage = (title: string) =>
  `<html><head><title>${title}</title></head><body><nav>Menu</nav><article><h1>${title}</h1>` +
  `<p>${para}</p><p>Second &amp; last <a href="/more">link</a><script>alert(1)</script><img src="x.png"></p><p>${para}</p></article></body></html>`;

const rss = (items: string[]) =>
  `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Example Blog</title>${
    items.map((n) => `<item><title>Post ${n}</title><link>https://blog.test/${n}</link><description>short</description></item>`).join('')
  }</channel></rss>`;

function site(pages: Record<string, string>): HttpTransport {
  return async (url) => {
    const text = pages[url];
    return { status: text === undefined ? 404 : 200, text: async () => text ?? '', json: async () => ({}) };
  };
}

function entries(zip: Buffer): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => yauzl.fromBuffer(zip, { lazyEntries: true }, (err, file) => {
    if (err) return reject(err);
    const out: Record<string, string> = {};
    file.on('entry', (entry) => file.openReadStream(entry, (e, stream) => {
      if (e) return reject(e);
      const chunks: Buffer[] = [];
      stream.on('data', (c) => chunks.push(c)).on('end', () => { out[entry.fileName] = Buffer.concat(chunks).toString(); file.readEntry(); });
    }));
    file.on('end', () => resolve(out));
    file.readEntry();
  }));
}

const post = (headers: Record<string, string>, url: string) => ({ method: 'POST', headers, body: JSON.stringify({ url }) });

describe('newspaper', () => {
  it('bundles saved pages and feed items into one sanitized EPUB, once', async () => {
    const pages: Record<string, string> = {
      'https://news.test/story': articlePage('Saved Story'),
      'https://blog.test/feed': rss(['1', '2']),
      'https://blog.test/1': articlePage('Post 1'),
      'https://blog.test/2': articlePage('Post 2'),
    };
    const { app, db } = makeTestApp({}, { connectorTransport: site(pages) });
    const { headers } = await registerUser(app);

    const saved = await app.request('/api/v1/newspaper/articles', post(headers, 'https://news.test/story'));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ title: 'Saved Story' });
    expect((await app.request('/api/v1/newspaper/feeds', post(headers, 'https://blog.test/feed'))).status).toBe(200);

    const res = await app.request('/api/v1/newspaper/issue/today.epub', { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/epub+zip');
    const files = await entries(Buffer.from(await res.arrayBuffer()));
    expect(Object.keys(files)[0]).toBe('mimetype');
    expect(files['OEBPS/content.opf']).toContain('<dc:creator>CrossPoint</dc:creator>');
    expect(files['OEBPS/content.opf']).toContain('<item id="cover" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>');
    // Saved pages lead; feed items follow under their feed's name.
    expect(files['OEBPS/nav.xhtml']).toMatch(/Saved<\/span>.*Saved Story.*Example Blog<\/span>.*Post 1.*Post 2/s);
    const story = files['OEBPS/a1.xhtml'];
    expect(story).toContain('Second &amp; last link'); // links are unwrapped: a reader cannot follow them
    expect(story).not.toContain('<a ');
    expect(story).toContain('min read');
    expect(story).not.toMatch(/script|img|Menu/);

    // A new post arrives: the same day's paper grows, and nothing repeats.
    pages['https://blog.test/feed'] = rss(['1', '2', '3']);
    pages['https://blog.test/3'] = articlePage('Post 3');
    db.exec('UPDATE news_feeds SET fetched_at = 0');
    const again = await entries(Buffer.from(await (await app.request('/api/v1/newspaper/issue/today.epub', { headers })).arrayBuffer()));
    expect(Object.keys(again).filter((n) => /a\d+\.xhtml/.test(n))).toHaveLength(4);

    // Removing a feed takes its articles along; other users see nothing.
    const { feeds } = await (await app.request('/api/v1/newspaper', { headers })).json();
    await app.request(`/api/v1/newspaper/feeds/${feeds[0].id}`, { method: 'DELETE', headers });
    const left = await (await app.request('/api/v1/newspaper', { headers })).json();
    expect(left.articles.map((a: { title: string }) => a.title)).toEqual(['Saved Story']);
    const other = await registerUser(app);
    expect((await app.request('/api/v1/newspaper/issue/today.epub', { headers: other.headers })).status).toBe(404);
  });

  it('includes an attributed Kagi briefing with saved pages and reuses the issue snapshot', async () => {
    const base = 'https://news.kagi.com/api/batches';
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const batch = 'a5271a19-6f23-453f-a6df-6a2e3ea7ebfe';
    const category = 'fc51072b-3a2c-4444-a607-ec5fe3b1f1c1';
    const pages: Record<string, string> = {
      [base + '/latest']: JSON.stringify({ id: batch, createdAt }),
      [base + '/' + batch + '/categories']: JSON.stringify({
        batchId: batch, categories: [{ id: category, categoryId: 'world', categoryName: 'World' }],
      }),
      [base + '/' + batch + '/categories/' + category + '/stories?lang=en&limit=20']: JSON.stringify({
        batchId: batch, categoryId: category,
        stories: [{
          cluster_number: 1, title: 'Ports & tides', short_summary: 'Shared alerts <for everyone>.',
          articles: [{ link: 'https://publisher.test/story', domain: 'Publisher' }, { link: 'javascript:bad()' }],
        }],
      }),
      'https://news.test/story': articlePage('Saved Story'),
    };
    const requests: string[] = [];
    const { app } = makeTestApp({ crossPaperKagiNews: true }, { connectorTransport: async (url, init) => {
      requests.push(url);
      return site(pages)(url, init);
    } });
    const { headers, username } = await registerUser(app);
    const root = '/api/v1/newspaper';
    const catalog = await app.request(root + '/kagi/categories', { headers });
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toEqual({ categories: [{ id: 'world', name: 'World' }] });
    const config = await app.request(root + '/kagi', {
      method: 'PUT', headers, body: JSON.stringify({ categories: ['world'] }),
    });
    expect(config.status).toBe(200);
    await app.request(root + '/articles', post(headers, 'https://news.test/story'));
    const pull = async () => {
      const response = await app.request(root + '/issue/today.epub', { headers });
      expect(response.status).toBe(200);
      return entries(Buffer.from(await response.arrayBuffer()));
    };
    const files = await pull();
    expect(files['OEBPS/nav.xhtml']).toMatch(/Saved Story.*Kagi News.*World.*Ports &amp; tides/s);
    expect(files['OEBPS/a2.xhtml']).toContain('Shared alerts &lt;for everyone&gt;.');
    expect(files['OEBPS/a2.xhtml']).toContain('https://publisher.test/story');
    expect(files['OEBPS/a2.xhtml']).toContain('https://news.kagi.com/api-docs');
    expect(files['OEBPS/a2.xhtml']).not.toContain('javascript:');
    expect((await pull())['OEBPS/a2.xhtml']).toBe(files['OEBPS/a2.xhtml']);
    const authorization = 'Basic ' + Buffer.from(username + ':' + headers['x-auth-key']).toString('base64');
    const opds = await app.request('/opds/crosspaper/today.epub', { headers: { authorization } });
    expect(opds.status).toBe(200);
    expect((await entries(Buffer.from(await opds.arrayBuffer())))['OEBPS/a2.xhtml']).toBe(files['OEBPS/a2.xhtml']);
    const remove = await app.request(root + '/kagi', {
      method: 'PUT', headers, body: JSON.stringify({ categories: [] }),
    });
    expect(remove.status).toBe(200);
    expect((await pull())['OEBPS/a2.xhtml']).toBe(files['OEBPS/a2.xhtml']);
    expect(requests.filter((url) => url.includes('/stories?'))).toHaveLength(1);
    const overview = await (await app.request(root, { headers })).json();
    expect(overview.kagi.categories).toEqual([]);
    expect(overview.articles).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Ports & tides' })]));
    const other = await registerUser(app);
    expect((await app.request(root + '/issue/today.epub', { headers: other.headers })).status).toBe(404);
  });

  it('keeps the article and drops the page around it', () => {
    const page = `<html><head><title>Robots at Work</title></head><body>
      <nav><a href="/">Home</a><a href="/news">News</a></nav>
      <article>
        <h1>Robots at Work</h1>
        <p>By Jane Doe</p>
        <p>Updated 39 minutes ago</p>
        <div class="social-share"><a href="#">Share on Facebook</a></div>
        <p>${para}</p>
        <ul><li><a href="/a">Another headline entirely</a></li><li><a href="/b">A second unrelated headline</a></li></ul>
        <p>The middle of the story cites a study<sup>[1]</sup> and carries on.</p>
        <p>${para}</p>
        <p>Follow us on Twitter</p>
        <p><a href="/full">Read the essay</a></p>
        <p>Jane Doe is a reporter covering robots and has written for many magazines.</p>
        <h2>Related articles</h2>
        <p>A teaser for something else that happens to be long enough to look like a paragraph of real prose.</p>
      </article>
      <aside class="newsletter-signup"><p>Sign up for our newsletter</p></aside>
      <footer>Copyright 2026</footer>
    </body></html>`;
    const article = extractArticle(page, 'https://news.test/robots')!;
    const read = article.content.replace(/<[^>]+>/g, ' ');
    expect(read).toContain('quick brown fox');
    expect(read).toContain('cites a study and carries on');
    for (const junk of ['Jane Doe', 'Updated', 'Share on', 'Another headline', 'Follow us', 'Read the essay', 'Related', 'teaser', 'newsletter', 'Copyright', 'Home', '[1]']) {
      expect(read).not.toContain(junk);
    }
    // Flat reading markup: paragraphs, no wrappers, no links.
    expect(article.content).not.toMatch(/<div|<a |<section/);
    expect(article.byline).toBe('Jane Doe, news.test');
  });

  it('uses the publisher\'s own copy of the article to decide what belongs', () => {
    const first = 'The council voted on Tuesday to rebuild the old harbour bridge, ending a debate that had run for most of a decade. '.repeat(3);
    const second = 'Engineers say the work will take two years and that the crossing will stay open to walkers throughout. '.repeat(3);
    const promo = 'Our award winning app is the fastest way to keep up with everything happening in your town, every single day of the week.';
    const page = (body: string, extra = '') => `<html><head><title>Bridge Vote</title>
      <script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'NewsArticle', headline: 'Bridge Vote', author: [{ name: 'Ann Lee' }, { name: 'Bo Diaz' }], articleBody: body }] })}</script>
      <script type="application/ld+json">{ not json</script></head>
      <body><article><h1>Bridge Vote</h1><p>${first}</p><p>${promo}</p><h2>What happens next</h2><p>${second}</p><h2>Elsewhere</h2><p>${promo}</p></article>${extra}</body></html>`;

    // The promo paragraphs read like prose, so no rule catches them; the publisher's copy does.
    const article = extractArticle(page(`${first}\n\n${second}`), 'https://news.test/bridge')!;
    const read = article.content.replace(/<[^>]+>/g, ' ');
    expect(read).toContain('rebuild the old harbour bridge');
    expect(read).toContain('What happens next');
    expect(read).toContain('stay open to walkers');
    expect(read).not.toContain('award winning app');
    expect(read).not.toContain('Elsewhere'); // a subheading with nothing left under it
    expect(article.byline).toBe('Ann Lee, Bo Diaz, news.test');

    // A teaser (as before a paywall) covers too little of the page to be trusted as the judge.
    const teased = extractArticle(page(first.slice(0, 120)), 'https://news.test/bridge')!;
    expect(teased.content).toContain('award winning app');

    // A page drawn by scripts has nothing to extract, but still carries the publisher's copy.
    const scripted = extractArticle(`<html><head><title>Bridge Vote</title><script type="application/ld+json">${JSON.stringify({ '@type': 'Article', articleBody: `${first}\n${second}` })}</script></head><body><div id="root"></div></body></html>`, 'https://news.test/bridge')!;
    expect(scripted.title).toBe('Bridge Vote');
    expect(scripted.content.match(/<p>/g)).toHaveLength(2);
  });

  it('closes a past day into its own edition, which stays downloadable', async () => {
    const { app, db } = makeTestApp({}, { connectorTransport: site({ 'https://news.test/story': articlePage('Saved Story') }) });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/newspaper/articles', post(headers, 'https://news.test/story'));
    // Saved two days ago and never fetched.
    const then = Math.floor(Date.now() / 1000) - 2 * 86_400;
    db.prepare('UPDATE news_articles SET created_at = ?').run(then);
    const day = new Date(then * 1000).toISOString().slice(0, 10);

    const { articles } = await (await app.request('/api/v1/newspaper', { headers })).json();
    expect(articles).toMatchObject([{ title: 'Saved Story', issue: day }]);
    expect((await app.request('/api/v1/newspaper/issue/today.epub', { headers })).status).toBe(404);
    const past = await app.request(`/api/v1/newspaper/issue/${day}.epub`, { headers });
    expect(past.status).toBe(200);
    // Named the way a person writes the date: "CrossPaper Nov 16 2026.epub".
    const written = new Date(then * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).replace(',', '');
    expect(past.headers.get('content-disposition')).toContain(`CrossPaper ${written}.epub`);
  });

  it('finds a feed from a site home page and rejects pages with no article', async () => {
    const { app } = makeTestApp({}, { connectorTransport: site({
      'https://blog.test/': '<html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head><body></body></html>',
      'https://blog.test/feed': rss([]),
      'https://empty.test/': '<html><body><p>Hi</p></body></html>',
    }) });
    const { headers } = await registerUser(app);
    const feed = await app.request('/api/v1/newspaper/feeds', post(headers, 'https://blog.test/'));
    expect(await feed.json()).toMatchObject({ url: 'https://blog.test/feed', title: 'Example Blog' });
    for (const url of ['https://empty.test/', 'https://missing.test/', 'ftp://x.test/', 'not a url']) {
      expect((await app.request('/api/v1/newspaper/articles', post(headers, url))).status).toBe(422);
    }
  });

  it('serves the paper over OPDS with the sync username and password', async () => {
    const { app } = makeTestApp({}, { connectorTransport: site({ 'https://news.test/story': articlePage('Saved Story') }) });
    const password = 'correct horse battery staple';
    const { username, headers } = await registerUser(app, password);
    await app.request('/api/v1/newspaper/articles', post(headers, 'https://news.test/story'));
    const basic = (pass: string) => ({ authorization: `Basic ${Buffer.from(`${username}:${pass}`).toString('base64')}` });

    expect((await app.request('/opds/crosspaper')).status).toBe(401);
    expect((await app.request('/opds/crosspaper', { headers: basic('wrong') })).status).toBe(401);
    expect((await app.request('/opds/crosspaper/today.epub', { headers: basic('wrong') })).status).toBe(401);
    const feed = await app.request('/opds/crosspaper', { headers: basic(password) });
    expect(await feed.text()).toContain('href="/opds/crosspaper/today.epub"');
    const epub = await app.request('/opds/crosspaper/today.epub', { headers: basic(password) });
    expect(epub.headers.get('content-type')).toBe('application/epub+zip');
  });

  it('draws a baseline JPEG cover in the panel\'s four native greys', () => {
    const jpg = renderCover({ name: 'CrossPaper', date: '2026-11-16' });
    const sof = jpg.indexOf(Buffer.from([0xff, 0xc0])); // SOF0 = baseline; the reader cannot decode progressive
    expect(sof).toBeGreaterThan(0);
    expect(jpg.includes(Buffer.from([0xff, 0xc2]))).toBe(false);
    const { width, height, data } = jpeg.decode(jpg);
    expect([width, height]).toEqual([1440, 2400]); // three times the reader's screen, scaled down on the device
    // Every flat area sits on a native level; anything in between would dither into noise.
    // Edges (type, halftone dots) are antialiased, so only pixels with flat surroundings count.
    const at = (x: number, y: number) => data[(y * width + x) * 4];
    const near = [0, 0, 0, 0];
    let flat = 0, off = 0;
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const around = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1), at(x, y)];
      if (Math.max(...around) - Math.min(...around) > 10) continue;
      flat++;
      const level = Math.round(at(x, y) / 85);
      if (Math.abs(at(x, y) - level * 85) > 20) off++; else near[level]++;
    }
    expect(off / flat).toBeLessThan(0.005);
    expect(near[0]).toBeGreaterThan(width * height * 0.01); // black type (halftoned, so less of it is flat)
    expect(near[1]).toBeGreaterThan(width * height * 0.1); // the dark grey field
    // Text sits on white: below the field, grey appears only on glyph edges.
    let grey = 0;
    const rows = [400 * 3, height - 30 * 3]; // between the field and the bottom band
    for (let p = rows[0] * width * 4; p < rows[1] * width * 4; p += 4) if (Math.abs(data[p] - 85) < 25) grey++;
    expect(grey / ((rows[1] - rows[0]) * width)).toBeLessThan(0.02);
  });

  it('never fetches private or loopback addresses', async () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1']) expect(isPublicAddress(a)).toBe(false);
    for (const a of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) expect(isPublicAddress(a)).toBe(true);
    await expect(safeFetch('http://127.0.0.1:1/', { method: 'GET' })).rejects.toThrow('Address not allowed');
    await expect(safeFetch('http://[::1]:1/', { method: 'GET' })).rejects.toThrow('Address not allowed');
    await expect(safeFetch('http://localhost:1/', { method: 'GET' })).rejects.toThrow('Address not allowed');
  });
});
