import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';

const BM = {
  id: '9f86d081884c7d65',
  xpath: '/body/DocFragment[3]/body/p[12]/text().0',
  percentage: 0.35,
  summary: 'It was the best of times, it was the worst of',
  si: 3,
  pc: 120,
  pp: 42,
};

describe('v1 bookmarks sync', () => {
  it('round-trips a batch upsert', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const put = await app.request(`/api/v1/bookmarks/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [BM] }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).accepted).toBe(1);

    const res = await app.request(`/api/v1/bookmarks/${DOC}`, { headers });
    const body = await res.json();
    expect(body.more).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ ...BM, deleted: 0 });
  });

  it('re-upserting the same id is idempotent (LWW)', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request(`/api/v1/bookmarks/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [BM] }),
    });
    await app.request(`/api/v1/bookmarks/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [{ ...BM, summary: 'updated' }] }),
    });
    const body = await (await app.request(`/api/v1/bookmarks/${DOC}`, { headers })).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].summary).toBe('updated');
  });

  it('tombstones delete and still appear in delta responses', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request(`/api/v1/bookmarks/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [BM] }),
    });
    await app.request(`/api/v1/bookmarks/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [{ id: BM.id, deleted: 1 }] }),
    });
    const body = await (await app.request(`/api/v1/bookmarks/${DOC}`, { headers })).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].deleted).toBe(1);
  });

  it('paginates with since/limit and the more flag', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    const items = Array.from({ length: 5 }, (_, i) => ({
      ...BM,
      id: `bm${i}`,
      percentage: i / 10,
    }));
    await app.request(`/api/v1/bookmarks/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items }),
    });
    // Spread updated_at so the cursor has distinct values to page over.
    for (let i = 0; i < 5; i++) {
      db.prepare('UPDATE bookmarks SET updated_at = updated_at + ? WHERE id = ?').run(i, `bm${i}`);
    }
    const page1 = await (
      await app.request(`/api/v1/bookmarks/${DOC}?limit=2`, { headers })
    ).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.more).toBe(true);
    const page2 = await (
      await app.request(`/api/v1/bookmarks/${DOC}?since=${page1.until}&limit=100`, { headers })
    ).json();
    expect(page2.more).toBe(false);
    const seen = [...page1.items, ...page2.items].map((i: { id: string }) => i.id);
    expect(new Set(seen).size).toBe(5);
  });

  it('pages same-second changes and deletions with revision cursors', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const put = (items: unknown[]) => app.request(`/api/v1/bookmarks/${DOC}`, {
      method: 'PUT', headers, body: JSON.stringify({ items }),
    });
    await put(Array.from({ length: 5 }, (_, i) => ({ ...BM, id: `bm${i}` })));
    let cursor = 0;
    const seen: string[] = [];
    for (;;) {
      const page = await (await app.request(`/api/v1/bookmarks/${DOC}?cursor=${cursor}&limit=2`, { headers })).json();
      expect(page.sync_version).toBe(2);
      seen.push(...page.items.map((item: { id: string }) => item.id));
      cursor = page.cursor;
      if (!page.more) break;
    }
    expect(new Set(seen).size).toBe(5);
    await put([{ id: 'bm0', deleted: 1 }]);
    const delta = await (await app.request(`/api/v1/bookmarks/${DOC}?cursor=${cursor}`, { headers })).json();
    expect(delta.items).toHaveLength(1);
    expect(delta.items[0]).toMatchObject({ id: 'bm0', deleted: 1 });
    expect(delta.cursor).toBeGreaterThan(cursor);
    for (const invalid of ['-1', 'nope', '1.5']) {
      expect((await app.request(`/api/v1/bookmarks/${DOC}?cursor=${invalid}`, { headers })).status).toBe(403);
    }
  });

  it('shares bookmarks through merged document aliases without exposing other accounts', async () => {
    const { app, db } = makeTestApp();
    const { headers, username } = await registerUser(app);
    const other = await registerUser(app);
    const alias = 'b'.repeat(32);
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username)!;
    db.prepare('INSERT INTO document_aliases (user_id, alias, document, created_at) VALUES (?, ?, ?, 0)').run(user.id, alias, DOC);
    expect((await app.request(`/api/v1/bookmarks/${alias}`, {
      method: 'PUT', headers, body: JSON.stringify({ items: [BM] }),
    })).status).toBe(200);
    for (const document of [alias, DOC]) {
      const body = await (await app.request(`/api/v1/bookmarks/${document}?cursor=0`, { headers })).json();
      expect(body.items).toHaveLength(1);
      const privateBody = await (await app.request(`/api/v1/bookmarks/${document}?cursor=0`, { headers: other.headers })).json();
      expect(privateBody.items).toHaveLength(0);
    }
  });

  it('rejects invalid items', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    for (const bad of [
      { items: [] },
      { items: [null] },
      { items: [BM, null] },
      { items: [[]] },
      { items: [{ xpath: 'x', percentage: 0.5 }] }, // no id
      { items: [{ id: 'a', xpath: 'x', percentage: 2 }] },
    ]) {
      const res = await app.request(`/api/v1/bookmarks/${DOC}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(403);
    }
  });
});
