import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  adpDigestHeader,
  extractSidecarGuid,
  fetchContent,
  fetchLastRead,
  parseLastReadXml,
  parseSyncMetadataXml,
  registerDevice,
  signingDate,
  FionaError,
  type FionaDevice,
} from '../src/connectors/kindle-fiona.js';
import type { HttpTransport } from '../src/connectors/types.js';

/** Generate a device identity for tests (real RSA key; signing is round-tripped). */
function testDevice(): FionaDevice {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  return {
    adpToken: 'test-adp-token',
    privateKey: Buffer.from(der).toString('base64'),
    deviceSerial: 'a'.repeat(40),
    deviceName: 'CrossPoint Sync',
  };
}

function transportReturning(status: number, body: string | Buffer): {
  transport: HttpTransport;
  calls: { url: string; method: string; headers?: Record<string, string>; body?: string }[];
} {
  const calls: { url: string; method: string; headers?: Record<string, string>; body?: string }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    return {
      status,
      body: Buffer.isBuffer(body)
        ? new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(body); c.close(); } })
        : null,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
  return { transport, calls };
}

describe('Fiona request signing', () => {
  it('formats the signing date without milliseconds', () => {
    expect(signingDate(new Date('2026-09-22T12:34:56.789Z'))).toBe('2026-09-22T12:34:56Z');
  });

  it('produces a verifiable RSA-private-encrypted SHA-256 digest', () => {
    const device = testDevice();
    const date = '2026-09-22T12:34:56Z';
    const header = adpDigestHeader({
      method: 'GET',
      requestPath: '/FionaTodoListProxy/syncMetaData',
      device,
      date,
    });
    // The signature is base64 (no colons); the ISO date contains them.
    const sep = header.indexOf(':');
    const sigB64 = header.slice(0, sep);
    const headerDate = header.slice(sep + 1);
    expect(headerDate).toBe(date);

    // Kindle ADP: RSA private operation over the raw SHA-256 digest; the server
    // reverses it with the public operation. Verify the round-trip.
    const key = crypto.createPrivateKey({
      key: Buffer.from(device.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const recovered = crypto.publicDecrypt(
      { key: crypto.createPublicKey(key), padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(sigB64, 'base64')
    );
    const expected = crypto
      .createHash('sha256')
      .update(`GET\n/FionaTodoListProxy/syncMetaData\n${date}\n\n${device.adpToken}`, 'utf8')
      .digest();
    expect(recovered.equals(expected)).toBe(true);
  });
});

describe('registerDevice', () => {
  it('returns otp_required on a 401 and preserves the serial for the retry', async () => {
    const { transport, calls } = transportReturning(401, '<error/>');
    const result = await registerDevice(transport, {
      email: 'u@example.com',
      password: 'secret',
      deviceSerial: 'b'.repeat(40),
    });
    expect(result).toEqual({ status: 'otp_required', deviceSerial: 'b'.repeat(40) });
    expect(calls[0].url).toBe('https://firs-ta-g7g.amazon.com/FirsProxy/registerDevice');
    expect(calls[0].body).toContain('<email>u@example.com</email>');
    expect(calls[0].body).toContain('<password>secret</password>');
    expect(calls[0].body).toContain(`<deviceSerialNumber>${'b'.repeat(40)}</deviceSerialNumber>`);
  });

  it('escapes XML in credentials', async () => {
    const { transport, calls } = transportReturning(401, '<error/>');
    await registerDevice(transport, { email: 'a&b@example.com', password: 'x<y>"z' });
    expect(calls[0].body).toContain('<email>a&amp;b@example.com</email>');
    expect(calls[0].body).toContain('<password>x&lt;y&gt;&quot;z</password>');
  });

  it('parses the device credential from a 200 response', async () => {
    const xml =
      '<response><adp_token>tok123</adp_token><device_private_key>a2V5</device_private_key>' +
      '<user_device_name>CrossPoint Sync</user_device_name></response>';
    const { transport } = transportReturning(200, xml);
    const result = await registerDevice(transport, { email: 'u@example.com', password: 'secret' });
    expect(result.status).toBe('registered');
    if (result.status !== 'registered') return;
    expect(result.device.adpToken).toBe('tok123');
    expect(result.device.privateKey).toBe('a2V5');
    expect(result.device.deviceName).toBe('CrossPoint Sync');
  });

  it('treats a customer_not_found 401 as the OTP challenge (observed: both look identical)', async () => {
    const { transport } = transportReturning(
      401,
      '<response><customer_not_found>No customer found for this e-mail address and password.' +
      '</customer_not_found><error_code>401</error_code></response>'
    );
    const result = await registerDevice(transport, {
      email: 'u@example.com',
      password: 'secret',
      deviceSerial: 'c'.repeat(40),
    });
    expect(result).toEqual({ status: 'otp_required', deviceSerial: 'c'.repeat(40) });
  });

  it('throws a FionaError when Amazon rejects without credentials', async () => {
    const { transport } = transportReturning(200, '<response><message>bad code</message></response>');
    await expect(
      registerDevice(transport, { email: 'u@example.com', password: 'wrong' })
    ).rejects.toThrow(FionaError);
  });
});

describe('syncMetaData parsing (EBOK library)', () => {
  it('extracts books from meta_data blocks', () => {
    const xml =
      '<response><add_update_list>' +
      '<meta_data><ASIN>B001</ASIN><title><![CDATA[Book One]]></title><authors><author>Author A</author></authors></meta_data>' +
      '<meta_data><ASIN>B002</ASIN><title>Book Two</title></meta_data>' +
      '<meta_data><title>No ASIN — skipped</title></meta_data>' +
      '</add_update_list></response>';
    expect(parseSyncMetadataXml(xml)).toEqual([
      { asin: 'B001', title: 'Book One', author: 'Author A' },
      { asin: 'B002', title: 'Book Two', author: null },
    ]);
  });
});

describe('fetchContent', () => {
  it('claims a newer software revision for the delivery check', async () => {
    const { transport, calls } = transportReturning(200, 'x');
    await fetchContent(transport, testDevice(), 'B012345678', 'PDOC');
    expect(calls[0].url).toContain('FSDownloadContent?type=PDOC&key=B012345678');
    expect(calls[0].url).toContain('is_archived_items=1');
    expect(calls[0].url).toContain('software_rev=1221328936');
  });
});

describe('last_read', () => {
  const LAST_READ_XML =
    '<book><last_read annotation_time_utc="2026-09-01T12:34:56Z" lto="0" pos="73889" ' +
    'source_device="Kindle for Android Phone" method="FRL" version="0"/></book>';

  it('parses position, method, timestamp and source device', () => {
    expect(parseLastReadXml(LAST_READ_XML)).toEqual({
      found: true,
      pos: 73889,
      method: 'FRL',
      annotationTimeUtc: '2026-09-01T12:34:56Z',
      sourceDevice: 'Kindle for Android Phone',
    });
  });

  it('reports not-found when no last_read element exists', () => {
    expect(parseLastReadXml('<book/>').found).toBe(false);
  });

  it('extracts the sidecar GUID from the first 32 bytes', () => {
    const guid = 'ABCDEF0123456789';
    const buf = Buffer.concat([
      Buffer.from(guid, 'ascii'),
      Buffer.alloc(32 - guid.length),
      Buffer.from('binary-payload'),
    ]);
    expect(extractSidecarGuid(buf)).toBe(guid);
    expect(extractSidecarGuid(Buffer.alloc(10))).toBeNull();
  });

  it('fetches the sidecar guid then getAnnotations, signed, and parses the result', async () => {
    const device = testDevice();
    const guid = 'GUIDXYZ';
    const sidecar = Buffer.concat([Buffer.from(guid, 'ascii'), Buffer.alloc(32 - guid.length), Buffer.from('x')]);
    const calls: string[] = [];
    const transport: HttpTransport = async (url, init) => {
      calls.push(url);
      expect(init.headers?.['x-adp-authentication-token']).toBe(device.adpToken);
      expect(init.headers?.['x-adp-request-digest']).toMatch(/^[A-Za-z0-9+/=]+:\d{4}-\d{2}-\d{2}T/);
      if (url.includes('/sidecar')) {
        return {
          status: 200,
          body: new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(sidecar); c.close(); } }),
          text: async () => sidecar.toString('utf8'),
          json: async () => ({}),
        };
      }
      return {
        status: 200,
        body: null,
        text: async () => LAST_READ_XML,
        json: async () => ({}),
      };
    };
    const result = await fetchLastRead(transport, device, 'B012345678', 'PDOC');
    expect(calls[0]).toContain('cde-ta-g7g.amazon.com/FionaCDEServiceEngine/sidecar?type=PDOC&key=B012345678');
    expect(calls[1]).toContain(`/getAnnotations?filter=last_read&type=PDOC&key=B012345678&guid=${guid}`);
    expect(result?.found).toBe(true);
    expect(result?.pos).toBe(73889);
  });

  it('returns null when the doc has no sidecar (404)', async () => {
    const { transport } = transportReturning(404, '<error/>');
    const result = await fetchLastRead(transport, testDevice(), 'B012345678', 'PDOC');
    expect(result).toBeNull();
  });
});
