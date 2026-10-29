import type { Connector, HttpTransport } from './types.js';
import { hardcoverConnector } from './hardcover.js';
import { readwiseConnector } from './readwise.js';
import { readwiseReaderConnector } from './readwise-reader.js';
import { kosyncConnector } from './kosync.js';
import { bookfusionConnector } from './bookfusion.js';
import { audiobookshelfConnector } from './audiobookshelf.js';
import { jellyfinConnector } from './jellyfin.js';
import { microblogConnector } from './microblog.js';
import { kindleConnector } from './kindle.js';
import { bookorbitConnector } from './bookorbit.js';
import { spotifyConnector } from './spotify.js';
import { seekquelConnector } from './seekquel.js';

let byId: Map<string, Connector> | undefined;

/** Storage and connectors can import each other; resolve exports on first use. */
function connectorRegistry(): Map<string, Connector> {
  if (!byId) {
    const connectors: Connector[] = [
      kosyncConnector,
      hardcoverConnector,
      readwiseConnector,
      readwiseReaderConnector,
      bookfusionConnector,
      audiobookshelfConnector,
      jellyfinConnector,
      bookorbitConnector,
      spotifyConnector,
      seekquelConnector,
      microblogConnector,
      kindleConnector,
    ];
    byId = new Map(connectors.map((c) => [c.id, c]));
  }
  return byId;
}

/** Connectors shown in the UI/API (excludes hidden ones). */
export function listConnectors(): Connector[] {
  return [...connectorRegistry().values()].filter((c) => !c.hidden);
}

export function getConnector(id: string): Connector | undefined {
  return connectorRegistry().get(id);
}

/** Default transport: the platform fetch, adapted to HttpTransport. */
export const fetchTransport: HttpTransport = async (url, init) => {
  const res = await fetch(url, init);
  return {
    status: res.status,
    headers: res.headers,
    body: res.body,
    text: () => res.text(),
    json: () => res.json(),
  };
};
