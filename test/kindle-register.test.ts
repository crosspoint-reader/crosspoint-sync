import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, registerUser } from './helpers.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import type { HttpTransport } from '../src/connectors/types.js';

const KEY = { TOKEN_ENC_KEY: 'a'.repeat(64) };
beforeEach(() => {
  Object.assign(process.env, KEY);
  resetEncryptionKeyCache();
});
afterEach(() => {
  delete process.env.TOKEN_ENC_KEY;
  resetEncryptionKeyCache();
});

function registerFake(sequence: { status: number; body: string }[]) {
  const calls: { url: string; body?: string }[] = [];
  let i = 0;
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, body: init.body });
    const step = sequence[Math.min(i++, sequence.length - 1)];
    return {
      status: step.status,
      body: null,
      text: async () => step.body,
      json: async () => ({}),
    };
  };
  return { transport, calls };
}

const REGISTERED_XML =
  '<response><adp_token>tok</adp_token><device_private_key>a2V5</device_private_key>' +
  '<user_device_name>CrossPoint Sync</user_device_name></response>';

describe('kindle server-side registration (KINDLE_SERVER_REGISTRATION)', () => {
  it('is not mounted unless the flag is on', async () => {
    const { app } = makeTestApp({}, { connectorTransport: registerFake([]).transport });
    const { headers } = await registerUser(app);
    const res = await app.request('/api/v1/connectors/kindle/register/begin', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'u@example.com', password: 'pw' }),
    });
    expect(res.status).toBe(404);
  });

  it('registers immediately when Amazon accepts the first attempt', async () => {
    const fake = registerFake([{ status: 200, body: REGISTERED_XML }]);
    const { app } = makeTestApp({ kindleServerRegistration: true }, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const res = await app.request('/api/v1/connectors/kindle/register/begin', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'u@example.com', password: 'pw' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'registered', linked: true, account: 'CrossPoint Sync' });
    expect(fake.calls[0].body).toContain('<email>u@example.com</email>');

    const list = await (await app.request('/api/v1/connectors', { headers })).json();
    const kindle = list.connectors.find((c: { id: string }) => c.id === 'kindle');
    expect(kindle.linked).toBe(true);
  });

  it('completes the OTP round trip and links the account', async () => {
    const fake = registerFake([
      { status: 401, body: '<error/>' },
      { status: 200, body: REGISTERED_XML },
    ]);
    const { app } = makeTestApp({ kindleServerRegistration: true }, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);

    const begin = await app.request('/api/v1/connectors/kindle/register/begin', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'u@example.com', password: 'pw' }),
    });
    expect(begin.status).toBe(200);
    const { status, nonce } = await begin.json();
    expect(status).toBe('otp_required');
    expect(typeof nonce).toBe('string');

    const bad = await app.request('/api/v1/connectors/kindle/register/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce: 'wrong', code: '123456' }),
    });
    expect(bad.status).toBe(403);

    const done = await app.request('/api/v1/connectors/kindle/register/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, code: '123456' }),
    });
    expect(done.status).toBe(200);
    expect((await done.json()).status).toBe('registered');
    // The code goes ALONE in the password field, reusing the same device serial.
    const firstSerial = /<deviceSerialNumber>([^<]+)<\/deviceSerialNumber>/.exec(fake.calls[0].body ?? '')?.[1];
    expect(fake.calls[1].body).toContain('<password>123456</password>');
    expect(fake.calls[1].body).toContain(`<deviceSerialNumber>${firstSerial}</deviceSerialNumber>`);

    const list = await (await app.request('/api/v1/connectors', { headers })).json();
    expect(list.connectors.find((c: { id: string }) => c.id === 'kindle').linked).toBe(true);
  });

  it('never stores the password; only the scoped device credential lands in the vault', async () => {
    const fake = registerFake([{ status: 200, body: REGISTERED_XML }]);
    const { app, db } = makeTestApp({ kindleServerRegistration: true }, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/connectors/kindle/register/begin', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'u@example.com', password: 'super-secret' }),
    });
    const row = db
      .prepare("SELECT cred_enc FROM connector_accounts WHERE connector_id = 'kindle'")
      .get() as { cred_enc: string };
    expect(row.cred_enc).not.toContain('super-secret');
    expect(row.cred_enc).not.toContain('u@example.com');
  });
});
