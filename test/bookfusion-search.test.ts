import { expect, it } from 'vitest';
import { bookfusionConnector } from '../src/connectors/bookfusion.js';
import type { HttpTransport } from '../src/connectors/types.js';

it('searches the BookFusion library for the picker and auto-matches on the title alone', async () => {
  const queries: string[] = [];
  const http: HttpTransport = async (_url, init) => {
    queries.push(JSON.parse(init.body!).query);
    const body = [{ id: 7, title: 'Dragons at Crumbling Castle', authors: [{ name: 'Terry Pratchett' }] }];
    return { status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const cred = { access_token: 't' };
  expect(await bookfusionConnector.search!(cred, 'dragons', http)).toEqual([
    { externalId: '7', title: 'Dragons at Crumbling Castle', author: 'Terry Pratchett' },
  ]);
  const m = await bookfusionConnector.match(cred, { document: 'd', title: 'Dragons at Crumbling Castle', author: 'Terry Pratchett' } as any, http);
  expect(m?.externalId).toBe('7');
  expect(queries).toEqual(['dragons', 'Dragons at Crumbling Castle']);
});
