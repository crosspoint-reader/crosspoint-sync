/**
 * CrossPoint Kindle Link — background service worker.
 *
 * Everything Amazon-side happens here, inside the user's browser: device
 * registration (password + emailed OTP are used for two registerDevice calls and
 * never stored) and the upload of the scoped ADP device credential to the user's
 * crosspoint-sync server. Purchased books are enumerated by the SERVER with that
 * credential; sideloaded (Send-to-Kindle) docs are matched by pasting their ASIN
 * on the dashboard's match page.
 */

import {
  parseRegisterResponseXml,
  registrationBody,
} from './lib.mjs';

const FIRS = 'https://firs-ta-g7g.amazon.com';
const DEVICE_TYPE = 'A2CZJZGLK2JJVM'; // Kindle for iPad (legacy iOS) — Amazon still delivers modern purchases to this identity
const SOFTWARE_VERSION = '1221328936';
export const DEVICE_NAME = 'CrossPoint Sync';

const store = {
  async get(keys) { return chrome.storage.local.get(keys); },
  async set(obj) { return chrome.storage.local.set(obj); },
};

// --- Amazon calls -------------------------------------------------------------------

/** One registerDevice attempt; resolves { otp: true } or { otp: false, device }. */
async function registerAttempt(email, password, serial) {
  const res = await fetch(`${FIRS}/FirsProxy/registerDevice`, {
    method: 'POST',
    headers: {
      'Accept-Language': 'en-US',
      'Content-Type': 'text/xml',
      'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 5.0; Nexus 1)',
    },
    body: registrationBody({ email, password, serial, deviceName: DEVICE_NAME, deviceType: DEVICE_TYPE, softwareVersion: SOFTWARE_VERSION }),
  });
  const text = await res.text();
  // The OTP challenge is signaled by <customer_not_found>/<error_code>401</error_code>
  // in the BODY; the HTTP status varies (observed 2026: not always 401). The same
  // body also means wrong password; the only distinguishing signal is whether the
  // OTP email arrives.
  if (res.status === 401 || text.includes('customer_not_found') || /<error_code>\s*401/.test(text)) {
    return { otp: true };
  }
  if (!res.ok) throw new Error(`Amazon registration failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  const parsed = parseRegisterResponseXml(text);
  return {
    otp: false,
    device: {
      adp_token: parsed.adpToken,
      private_key: parsed.privateKey,
      device_serial: serial,
      device_name: parsed.deviceName || DEVICE_NAME,
    },
  };
}

// --- upload --------------------------------------------------------------------------

async function uploadCredential() {
  const { server, username, authKey, credential } = await store.get([
    'server', 'username', 'authKey', 'credential',
  ]);
  if (!server || !authKey || !credential) throw new Error('not configured/registered');
  const res = await fetch(`${server}/api/v1/connectors/kindle`, {
    method: 'PUT',
    headers: {
      'x-auth-user': username,
      'x-auth-key': authKey,
      'content-type': 'application/json',
      accept: 'application/vnd.koreader.v1+json',
    },
    body: JSON.stringify({ credential }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`server rejected the link (HTTP ${res.status}): ${text.slice(0, 200)}`);
  await store.set({ lastUpload: Date.now(), lastError: null });
}

/** Upload that records the outcome instead of failing the registration it follows. */
async function uploadBestEffort() {
  try {
    await uploadCredential();
  } catch (e) {
    await store.set({ lastError: e?.message ?? String(e) });
  }
}

// --- messages ------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'connect': {
        const server = (msg.server.includes('://') ? msg.server : `https://${msg.server}`).replace(/\/+$/, '');
        const authKey = md5hex(msg.password);
        const res = await fetch(`${server}/users/auth`, {
          headers: { 'x-auth-user': msg.username, 'x-auth-key': authKey, accept: 'application/vnd.koreader.v1+json' },
        });
        if (!res.ok) throw new Error(`sync account auth failed (HTTP ${res.status})`);
        await store.set({ server, username: msg.username, authKey, lastError: null });
        // If a credential already exists (re-install), upload it right away.
        const { credential } = await store.get(['credential']);
        if (credential) await uploadBestEffort();
        return { ok: true };
      }
      case 'register-begin': {
        const serial = randomHex(20);
        const r = await registerAttempt(msg.email, msg.password, serial);
        if (r.otp) {
          await store.set({ pendingRegistration: { email: msg.email, serial, expiresAt: Date.now() + 10 * 60_000 } });
          return { ok: true, otp: true };
        }
        // Registration succeeded even if the upload fails; retry from the popup.
        await store.set({ credential: r.device, pendingRegistration: null, lastError: null });
        await uploadBestEffort();
        return { ok: true, otp: false };
      }
      case 'register-complete': {
        const { pendingRegistration } = await store.get(['pendingRegistration']);
        if (!pendingRegistration || pendingRegistration.expiresAt < Date.now()) {
          throw new Error('registration expired — start again');
        }
        const r = await registerAttempt(pendingRegistration.email, msg.code, pendingRegistration.serial);
        if (r.otp) {
          await store.set({ pendingRegistration: null });
          throw new Error('Amazon rejected that code. Start again with your password.');
        }
        await store.set({ credential: r.device, pendingRegistration: null, lastError: null });
        await uploadBestEffort();
        return { ok: true };
      }
      case 'upload': {
        await uploadCredential();
        return { ok: true };
      }
      case 'status': {
        const s = await store.get(['server', 'username', 'authKey', 'credential', 'lastUpload', 'lastError', 'pendingRegistration']);
        return {
          ok: true,
          configured: Boolean(s.server && s.username && s.authKey),
          registered: Boolean(s.credential),
          // Survives the popup closing (e.g. to read the OTP email).
          otpPending: Boolean(s.pendingRegistration && s.pendingRegistration.expiresAt > Date.now()),
          deviceName: s.credential?.device_name ?? null,
          server: s.server ?? null,
          username: s.username ?? null,
          lastUpload: s.lastUpload ?? null,
          lastError: s.lastError ?? null,
        };
      }
      case 'unlink': {
        await store.set({ credential: null, lastUpload: null, lastError: null });
        return { ok: true };
      }
      default:
        throw new Error('unknown message');
    }
  })().then(
    (r) => sendResponse(r),
    (err) => sendResponse({ ok: false, error: err?.message ?? String(err) })
  );
  return true; // async response
});

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Compact JS MD5 (WebCrypto has none). MD5 is the kosync password-at-rest
// protocol; the server never sees plaintext. Public-domain style reference
// implementation, UTF-8 input.
function md5hex(input) {
  const s = unescape(encodeURIComponent(input));
  const K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const bytes = [];
  for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push((bitLen / 2 ** (8 * i)) & 0xff);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const add = (x, y) => (x + y) | 0;
  const rol = (x, n) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < bytes.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) {
      M[i] = bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8) | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24);
    }
    let [A, B, C, D] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const tmp = D;
      D = C;
      C = B;
      B = add(B, rol(add(add(A, F), add(K[i], M[g])), S[i]));
      A = tmp;
    }
    a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
  }
  const out = [];
  for (const v of [a0, b0, c0, d0]) {
    for (let i = 0; i < 4; i++) out.push((v >>> (8 * i)) & 0xff);
  }
  return out.map((b) => b.toString(16).padStart(2, '0')).join('');
}
