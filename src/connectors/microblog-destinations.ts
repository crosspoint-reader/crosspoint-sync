import type { DB } from '../db/db.js';
import { ConnectorOperationError, type Credential, type HttpTransport } from './types.js';

export interface MicroblogDestination { uid: string; name: string; isDefault: boolean }

export async function listMicroblogDestinations(cred: Credential, http: HttpTransport): Promise<MicroblogDestination[]> {
  if (typeof cred.token !== 'string' || !cred.token.trim()) throw new ConnectorOperationError('Missing Micro.blog token', false, true);
  let res;
  try { res = await http('https://micro.blog/micropub?q=config', { method: 'GET', headers: { authorization: `Bearer ${cred.token.trim()}` } }); }
  catch { throw new ConnectorOperationError('Could not load Micro.blog blogs', true); }
  if (res.status >= 300) throw new ConnectorOperationError(`Micro.blog blog discovery failed (${res.status})`, res.status === 429 || res.status >= 500, res.status === 401 || res.status === 403);
  let config: { destination?: unknown };
  try { config = await res.json() as typeof config; } catch { throw new ConnectorOperationError('Micro.blog returned invalid blog configuration', true); }
  if (!config || !Array.isArray(config.destination)) throw new ConnectorOperationError('Micro.blog did not return available blogs', true);
  const byUid = new Map<string, MicroblogDestination>();
  for (const item of config.destination) {
    if (!item || typeof item !== 'object') continue;
    const d = item as { uid?: unknown; name?: unknown; 'microblog-default'?: unknown };
    if (typeof d.uid !== 'string') continue;
    try {
      const url = new URL(d.uid);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) continue;
      const uid = url.href;
      if (!byUid.has(uid)) byUid.set(uid, { uid, name: typeof d.name === 'string' && d.name.trim() ? d.name : uid, isDefault: d['microblog-default'] === true });
    } catch { /* Ignore malformed destination entries. */ }
  }
  return [...byUid.values()];
}

export function selectedMicroblogDestination(db: DB, userId: number): string | null {
  const account = db.prepare("SELECT options FROM connector_accounts WHERE user_id=? AND connector_id='microblog'").get(userId) as { options: string | null } | undefined;
  try { const value = JSON.parse(account?.options || '{}').highlight_blog; return typeof value === 'string' && value ? value : null; }
  catch { return null; }
}

/** URL origin and path boundaries prevent similar hostnames/prefixes matching. */
export function destinationForPost(url: string, blogs: MicroblogDestination[]): string | null {
  let post: URL;
  try { post = new URL(url); } catch { return null; }
  const matches = blogs.filter((blog) => {
    const base = new URL(blog.uid);
    const prefix = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    return post.origin === base.origin && (post.pathname === base.pathname || post.pathname.startsWith(prefix));
  }).sort((a, b) => b.uid.length - a.uid.length);
  return matches[0]?.uid ?? null;
}
