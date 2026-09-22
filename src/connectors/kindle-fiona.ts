import crypto from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import type { HttpTransport } from './types.js';

/**
 * Minimal client for Amazon's Kindle device sync protocol ("Whispersync", the
 * Fiona/CDE services) — the endpoints real Kindles and Kindle apps use. See
 * docs/design/kindle-sync.md.
 *
 * !!! LIVE-VERIFY GATE !!!
 * The read path here follows the protocol documented by ptbrowne (2020) and
 * re-verified against a live account + physical Kindle in Sept 2026 by the
 * kindle-whispersync-probe project. It is still a private API: re-run the
 * live-verify checklist in the design doc before trusting it broadly.
 * Search this file for GATE.
 *
 * Why plain fetch is fine: these are device APIs, not web pages — Amazon's
 * TLS fingerprinting (read.amazon.com, July 2023) does not apply here, and the
 * probe calls them with stock undici. Do not add a TLS-impersonation layer.
 */

export const FIONA_HOSTS = {
  firs: 'firs-ta-g7g.amazon.com',
  todo: 'todo-ta-g7g.amazon.com',
  cde: 'cde-ta-g7g.amazon.com',
} as const;

/** The Android-app device identity we register as (same as the reference probes). */
const DEVICE_TYPE = 'A2CZJZGLK2JJVM'; // Kindle for iPad (legacy iOS) — delivery-unlocked
const SOFTWARE_VERSION = '1221328936';
const REGISTRATION_UA = 'Dalvik/2.1.0 (Linux; U; Android 5.0; Nexus 1)';
const SIGNED_UA = 'Dalvik/1.2.0';

export type FionaContentType = 'PDOC' | 'EBOK';

/** The scoped device credential minted by registerDevice. */
export interface FionaDevice {
  adpToken: string;
  /** Base64 PKCS#8 DER RSA private key. */
  privateKey: string;
  deviceSerial: string;
  deviceName: string;
}

export class FionaError extends Error {
  constructor(
    message: string,
    public readonly status: number | null
  ) {
    super(message);
    this.name = 'FionaError';
  }
}

// --- Request signing ----------------------------------------------------------

/** Kindle ADP signing date: ISO-8601 UTC without milliseconds. */
export function signingDate(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function fionaPrivateKey(privateKeyB64: string): crypto.KeyObject {
  const clean = privateKeyB64.replace(/\s/g, '');
  if (clean.includes('-----BEGIN')) return crypto.createPrivateKey(privateKeyB64); // PEM
  const der = Buffer.from(clean, 'base64');
  // Android registrations return PKCS#8; iOS registrations return PKCS#1.
  for (const type of ['pkcs8', 'pkcs1'] as const) {
    try {
      return crypto.createPrivateKey({ key: der, format: 'der', type });
    } catch { /* try the next container */ }
  }
  throw new FionaError('unparseable device private key', null);
}

/**
 * The x-adp-request-digest header. Kindle's scheme is NOT an ordinary signature:
 * the client applies the RSA private operation (PKCS#1 v1.5 padding) directly to
 * the SHA-256 of "METHOD\nPATH\nDATE\nBODY\nADP_TOKEN". Server verifies with the
 * matching public operation.
 */
export function adpDigestHeader(opts: {
  method: string;
  requestPath: string;
  body?: string;
  device: Pick<FionaDevice, 'privateKey' | 'adpToken'>;
  date?: string;
}): string {
  const date = opts.date ?? signingDate();
  const data = `${opts.method}\n${opts.requestPath}\n${date}\n${opts.body ?? ''}\n${opts.device.adpToken.replace(/\n/g, '')}`;
  const digest = crypto.createHash('sha256').update(data, 'utf8').digest();
  const encrypted = crypto.privateEncrypt(
    { key: fionaPrivateKey(opts.device.privateKey), padding: crypto.constants.RSA_PKCS1_PADDING },
    digest
  );
  return `${encrypted.toString('base64')}:${date}`;
}

function signedHeaders(device: FionaDevice, method: string, requestPath: string, body = ''): Record<string, string> {
  return {
    'User-Agent': SIGNED_UA,
    'x-adp-authentication-token': device.adpToken.replace(/\n/g, ''),
    'x-adp-request-digest': adpDigestHeader({ method, requestPath, body, device }),
  };
}

/** Read a transport response body as bytes (binary-safe; sidecars and book
 *  content are not valid UTF-8). Prefers the stream when the transport has one. */
async function readBytes(res: {
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}): Promise<Buffer> {
  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
    return Buffer.concat(chunks, size);
  }
  return Buffer.from(await res.text(), 'utf8');
}

/** Signed GET against a Fiona host; returns the raw body. Throws FionaError on non-2xx. */
export async function fionaGet(
  http: HttpTransport,
  device: FionaDevice,
  host: keyof typeof FIONA_HOSTS,
  requestPath: string
): Promise<Buffer> {
  const res = await http(`https://${FIONA_HOSTS[host]}${requestPath}`, {
    method: 'GET',
    headers: signedHeaders(device, 'GET', requestPath),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status < 200 || res.status >= 300) {
    const text = await res.text();
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new FionaError(
      `GET ${requestPath} -> HTTP ${res.status}${preview ? `: ${preview}` : ''}`,
      res.status
    );
  }
  return readBytes(res);
}

// --- Device registration (one-time, normally client-side via the CLI) ---------

export type RegisterResult =
  | { status: 'registered'; device: FionaDevice }
  // Amazon answered 401 and emailed a verification code; retry with the code in
  // the password field, reusing the same deviceSerial.
  | { status: 'otp_required'; deviceSerial: string };

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function registrationBody(email: string, password: string, serial: string, deviceName: string): string {
  return (
    `<request><parameters>` +
    `<deviceType>${DEVICE_TYPE}</deviceType>` +
    `<deviceSerialNumber>${escapeXml(serial)}</deviceSerialNumber>` +
    `<email>${escapeXml(email)}</email>` +
    `<password>${escapeXml(password)}</password>` +
    `<deviceName>${escapeXml(deviceName)}</deviceName>` +
    `<pid>510FD7ED</pid>` +
    `<softwareVersion>${SOFTWARE_VERSION}</softwareVersion>` +
    `<os_version>5.0</os_version>` +
    `<device_model>Android Phone</device_model>` +
    `</parameters><softwareVersions>` +
    `<softwareVersion name="oem_vendor" value="Kindle"/>` +
    `<softwareVersion name="oem_platform" value="Redding"/>` +
    `<softwareVersion name="oem_version" value="kindle-android-20"/>` +
    `</softwareVersions></request>`
  );
}

/**
 * One registration attempt. GATE: the observed 2026 flow is exactly two attempts —
 * real password -> 401 + verification email; then the emailed code ALONE in the
 * password field -> 200. Do not loop speculative extra rounds.
 */
export async function registerDevice(
  http: HttpTransport,
  opts: { email: string; password: string; deviceSerial?: string; deviceName?: string }
): Promise<RegisterResult> {
  const deviceSerial = opts.deviceSerial ?? crypto.randomBytes(20).toString('hex');
  const deviceName = opts.deviceName ?? 'CrossPoint Sync';
  const res = await http(`https://${FIONA_HOSTS.firs}/FirsProxy/registerDevice`, {
    method: 'POST',
    headers: {
      'Accept-Language': 'en-US',
      'Content-Type': 'text/xml',
      'User-Agent': REGISTRATION_UA,
    },
    body: registrationBody(opts.email, opts.password, deviceSerial, deviceName),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  // GATE (observed 2026): the OTP challenge is signaled by <customer_not_found>/
  // <error_code>401</error_code> in the BODY; the HTTP status varies (not always
  // 401). The same body also means wrong password; the only distinguishing signal
  // is whether the OTP email arrives, so this is always "check your email; no
  // email means the password was wrong".
  if (res.status === 401 || text.includes('customer_not_found') || /<error_code>\s*401/.test(text)) {
    return { status: 'otp_required', deviceSerial };
  }
  if (res.status < 200 || res.status >= 300) {
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new FionaError(`registerDevice -> HTTP ${res.status}${preview ? `: ${preview}` : ''}`, res.status);
  }

  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const field = (tag: string): string => doc.getElementsByTagName(tag)[0]?.textContent?.trim() ?? '';
  const adpToken = field('adp_token');
  const privateKey = field('device_private_key');
  if (!adpToken || !privateKey) {
    const message = field('message') || field('error') || 'Amazon did not return device credentials';
    throw new FionaError(`registerDevice failed: ${message}`, res.status);
  }
  return {
    status: 'registered',
    device: { adpToken, privateKey, deviceSerial, deviceName: field('user_device_name') || deviceName },
  };
}

// --- Signed reads -------------------------------------------------------------

/** Cheap authenticated call used to validate a stored credential. */
export async function fetchSyncMetadata(http: HttpTransport, device: FionaDevice): Promise<string> {
  const body = await fionaGet(http, device, 'todo', '/FionaTodoListProxy/syncMetaData');
  return body.toString('utf8');
}

export interface EbokEntry {
  asin: string;
  title: string;
  author: string | null;
}

/** Parse <meta_data> blocks out of syncMetaData (purchased books; PDOCs are absent). */
export function parseSyncMetadataXml(xmlText: string): EbokEntry[] {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const out: EbokEntry[] = [];
  const nodes = doc.getElementsByTagName('meta_data');
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const field = (tag: string): string => {
      const els = node.getElementsByTagName(tag);
      return els[0]?.textContent?.trim() ?? '';
    };
    const asin = field('ASIN');
    const title = field('title');
    if (!asin || !title) continue;
    out.push({ asin, title, author: field('author') || null });
  }
  return out;
}

/** The purchased-book library this device identity is offered (EBOKs only). */
export async function fetchEbokLibrary(http: HttpTransport, device: FionaDevice): Promise<EbokEntry[]> {
  return parseSyncMetadataXml(await fetchSyncMetadata(http, device));
}

/** The sidecar's GUID is its first 32 bytes, ASCII, NUL-padded. */
export function extractSidecarGuid(buf: Buffer): string | null {
  if (buf.length < 32) return null;
  const guid = buf.subarray(0, 32).toString('ascii').replace(/\0.*$/s, '').trim();
  return guid || null;
}

export async function fetchSidecarGuidFor(
  http: HttpTransport,
  device: FionaDevice,
  asin: string,
  type: FionaContentType
): Promise<string | null> {
  const path = `/FionaCDEServiceEngine/sidecar?type=${encodeURIComponent(type)}&key=${encodeURIComponent(asin)}`;
  let body: Buffer;
  try {
    body = await fionaGet(http, device, 'cde', path);
  } catch (err) {
    // A doc that has never synced has no sidecar (404) — that is not an error for us.
    if (err instanceof FionaError && err.status === 404) return null;
    throw err;
  }
  return extractSidecarGuid(body);
}

export interface LastRead {
  found: boolean;
  /** Byte offset into the decompressed converted text (format-specific space). */
  pos: number | null;
  /** 'FRL' (furthest read location) on current firmware. */
  method: string | null;
  /** Raw annotation_time_utc attribute, when present. */
  annotationTimeUtc: string | null;
  /** Which device reported this position (position-space diagnostic). */
  sourceDevice: string | null;
}

export function parseLastReadXml(xmlText: string): LastRead {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const node = doc.getElementsByTagName('last_read')[0];
  if (!node) return { found: false, pos: null, method: null, annotationTimeUtc: null, sourceDevice: null };
  const attr = (name: string): string | null => node.getAttribute(name);
  const rawPos = attr('pos');
  const pos = rawPos != null && rawPos !== '' ? Number(rawPos) : NaN;
  return {
    found: true,
    pos: Number.isFinite(pos) && pos >= 0 ? pos : null,
    method: attr('method'),
    annotationTimeUtc: attr('annotation_time_utc'),
    sourceDevice: attr('source_device'),
  };
}

/** The book's furthest-read annotation, or null when the doc has never synced. */
export async function fetchLastRead(
  http: HttpTransport,
  device: FionaDevice,
  asin: string,
  type: FionaContentType
): Promise<LastRead | null> {
  const guid = await fetchSidecarGuidFor(http, device, asin, type);
  if (!guid) return null;
  const path =
    `/FionaCDEServiceEngine/getAnnotations?filter=last_read&type=${encodeURIComponent(type)}` +
    `&key=${encodeURIComponent(asin)}&guid=${encodeURIComponent(guid)}`;
  const body = await fionaGet(http, device, 'cde', path);
  return parseLastReadXml(body.toString('utf8'));
}

/**
 * The converted book file Amazon delivers to our device identity (MOBI7). Used as
 * the "ruler" that turns a byte-offset position into a fraction. This is the whole
 * book — callers must cache the derived length, never re-download per poll.
 *
 * software_rev claims a Kindle software revision for the delivery check: Amazon
 * 403s (DELIVERY_NOT_SUPPORTED) modern purchases for old registered revisions.
 * The check is against the REGISTERED software version (the request param alone
 * does not unlock delivery — observed 2026-09-23), so this must match the
 * registration claim; both default to the modern app flow's 1221328936.
 * Override with KINDLE_SOFTWARE_REV for experiments.
 */
export function softwareRevision(env: NodeJS.ProcessEnv = process.env): string {
  return env.KINDLE_SOFTWARE_REV ?? '1221328936';
}

export async function fetchContent(
  http: HttpTransport,
  device: FionaDevice,
  asin: string,
  type: FionaContentType
): Promise<Buffer> {
  const path =
    `/FionaCDEServiceEngine/FSDownloadContent?type=${encodeURIComponent(type)}` +
    `&key=${encodeURIComponent(asin)}&is_archived_items=1&software_rev=${softwareRevision()}`;
  return fionaGet(http, device, 'cde', path);
}
