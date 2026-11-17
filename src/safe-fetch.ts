import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import type { HttpTransport } from './connectors/types.js';

/**
 * GET for URLs a user typed (saved pages, RSS feeds). The server must never be
 * a way to reach its own network, so every address a host resolves to is
 * checked inside the socket's lookup: the address validated is the address
 * connected to (no DNS-rebinding gap), and each redirect hop is checked again.
 */

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [['::', 127], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  blocked.addSubnet(addr, bits, 'ipv6');
}

/** False for loopback, private, link-local and multicast (IPv4-mapped IPv6 included). */
export const isPublicAddress = (address: string): boolean =>
  net.isIP(address) !== 0 && !blocked.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4');

const safeLookup: net.LookupFunction = (hostname, options, callback) =>
  dns.lookup(hostname, options, (err, address, family) => {
    const all = Array.isArray(address) ? address.map((a) => a.address) : [address];
    if (!err && !all.every(isPublicAddress)) err = Object.assign(new Error('Address not allowed'), { code: 'EBLOCKED' });
    (callback as (...args: unknown[]) => void)(err, address, family);
  });

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

function once(url: URL, signal: AbortSignal): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // An IP literal never reaches lookup, so check it here.
    if (net.isIP(host) && !isPublicAddress(host)) return reject(new Error('Address not allowed'));
    const req = (url.protocol === 'https:' ? https : http).get(url, {
      lookup: safeLookup,
      signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; CrossPointSync)',
        accept: 'text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.5',
        'accept-encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { req.destroy(new Error('Response too large')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks);
          const limit = { maxOutputLength: MAX_BYTES };
          const encoding = res.headers['content-encoding'];
          const body = encoding === 'gzip' ? zlib.gunzipSync(raw, limit)
            : encoding === 'br' ? zlib.brotliDecompressSync(raw, limit)
            : encoding === 'deflate' ? zlib.inflateSync(raw, limit)
            : raw;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
  });
}

function decode(body: Buffer, contentType = ''): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try { return new TextDecoder(charset).decode(body); } catch { return body.toString('utf8'); }
}

export const safeFetch: HttpTransport = async (target) => {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = new URL(target);
  for (let hop = 0; hop < 6; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs are supported');
    const res = await once(url, signal);
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) { url = new URL(location, url); continue; }
    const text = decode(res.body, res.headers['content-type']);
    return { status: res.status, text: async () => text, json: async () => JSON.parse(text) };
  }
  throw new Error('Too many redirects');
};
