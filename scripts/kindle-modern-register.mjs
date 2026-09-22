#!/usr/bin/env node
/**
 * Experiment: register with a MODERN deviceType through the proven legacy
 * FirsProxy/registerDevice email-OTP flow (no captcha on this account so far),
 * then test whether content delivery unlocks for a modern purchased book.
 *
 * Run:  node scripts/kindle-modern-register.mjs [deviceType] [asin]
 *   deviceType default: A2A33MVZVPQKHY  (modern Kindle for Android, from comix)
 *   asin       default: B00D5765T0     (the book that 403s for the legacy identity)
 *
 * Your Amazon password is used locally only, for the registration calls.
 * Prints the credential JSON at the end. No dependencies; Node >= 22.
 */

import crypto from 'node:crypto';
import readline from 'node:readline/promises';

const DEVICE_TYPE = process.argv[2] ?? 'A2CZJZGLK2JJVM'; // proven delivery-unlocked 2026-09-23
const ASIN = process.argv[3] ?? 'B00D5765T0';
const SOFTWARE_VERSION = '1221328936'; // matches the modern app flow
const FIRS = 'firs-ta-g7g.amazon.com';
const CDE = 'cde-ta-g7g.amazon.com';
const TODO = 'todo-ta-g7g.amazon.com';

const DEVICE_NAME = `CrossPoint Sync ${crypto.randomBytes(2).toString('hex')}`;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q) => (await rl.question(q)).trim();

function escapeXml(v) {
  return String(v)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function registrationBody(email, password, serial) {
  return (
    `<request><parameters>` +
    `<deviceType>${DEVICE_TYPE}</deviceType>` +
    `<deviceSerialNumber>${escapeXml(serial)}</deviceSerialNumber>` +
    `<email>${escapeXml(email)}</email>` +
    `<password>${escapeXml(password)}</password>` +
    `<deviceName>${DEVICE_NAME}</deviceName>` +
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

async function registerAttempt(email, password, serial) {
  const res = await fetch(`https://${FIRS}/FirsProxy/registerDevice`, {
    method: 'POST',
    headers: {
      'Accept-Language': 'en-US',
      'Content-Type': 'text/xml',
      'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 5.0; Nexus 1)',
    },
    body: registrationBody(email, password, serial),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (res.status === 401 || /<error_code>\s*401/.test(text) || text.includes('customer_not_found')) {
    return { otp: true };
  }
  if (!res.ok) return { failed: `HTTP ${res.status}: ${text.slice(0, 400)}` };
  const field = (t) => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(text)?.[1]?.trim() ?? '';
  if (!field('adp_token') || !field('device_private_key')) {
    return { failed: field('message') || field('error') || text.slice(0, 400) };
  }
  return {
    device: {
      adpToken: field('adp_token'),
      privateKey: field('device_private_key'),
      deviceName: field('user_device_name') || DEVICE_NAME,
    },
  };
}

function privateKeyObject(privateKeyB64) {
  const clean = privateKeyB64.replace(/\s/g, '');
  if (clean.includes('-----BEGIN')) return crypto.createPrivateKey(privateKeyB64); // PEM
  const der = Buffer.from(clean, 'base64');
  // Android registrations return PKCS#8; iOS registrations return PKCS#1.
  for (const type of ['pkcs8', 'pkcs1']) {
    try {
      return crypto.createPrivateKey({ key: der, format: 'der', type });
    } catch { /* try next */ }
  }
  throw new Error(`unparseable device private key (${der.length} bytes, starts ${der.subarray(0, 8).toString('hex')})`);
}

function oldSign({ method, requestPath, adpToken, privateKeyB64 }) {
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const data = `${method}\n${requestPath}\n${date}\n\n${adpToken}`;
  const digest = crypto.createHash('sha256').update(data, 'utf8').digest();
  const enc = crypto.privateEncrypt({ key: privateKeyObject(privateKeyB64), padding: crypto.constants.RSA_PKCS1_PADDING }, digest);
  return `${enc.toString('base64')}:${date}`;
}

async function signedGet(host, path, device) {
  const res = await fetch(`https://${host}${path}`, {
    headers: {
      'User-Agent': 'Dalvik/1.2.0',
      'x-adp-authentication-token': device.adpToken,
      'x-adp-request-digest': oldSign({ method: 'GET', requestPath: path, adpToken: device.adpToken, privateKeyB64: device.privateKey }),
    },
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

async function main() {
  console.log(`deviceType: ${DEVICE_TYPE}   softwareVersion: ${SOFTWARE_VERSION}   asin: ${ASIN}\n`);
  const email = await ask('Amazon email: ');
  const password = await ask('Amazon password (echoed): ');
  const serial = crypto.randomBytes(20).toString('hex');

  console.log('\n[1] registerDevice …');
  let r = await registerAttempt(email, password, serial);
  if (r.otp) {
    console.log('    Amazon emailed a verification code.');
    const code = await ask('    Enter the code: ');
    r = await registerAttempt(email, code, serial);
  }
  if (!r.device) {
    console.log(`    FAILED: ${r.failed ?? 'unknown'}`);
    console.log('    If the endpoint rejected this deviceType, try another:');
    console.log('      node scripts/kindle-modern-register.mjs A2CZJZGLK2JJVM');
    rl.close();
    return;
  }
  console.log(`    ok — registered "${r.device.deviceName}".`);

  // Print the credential BEFORE any test so a later failure can't lose it.
  const credJson = JSON.stringify({
    adp_token: r.device.adpToken,
    private_key: r.device.privateKey,
    device_serial: serial,
    device_name: r.device.deviceName,
  }, null, 2);
  console.log('\nCredential JSON:\n');
  console.log(credJson);
  console.log('');

  console.log('[2] syncMetaData (signing sanity) …');
  const meta = await signedGet(TODO, '/FionaTodoListProxy/syncMetaData', r.device).catch((e) => ({ status: `error: ${e.message}` }));
  console.log(`    HTTP ${meta.status}`);

  console.log(`[3] FSDownloadContent ${ASIN} …`);
  const dlPath = `/FionaCDEServiceEngine/FSDownloadContent?type=EBOK&key=${ASIN}&is_archived_items=1&software_rev=${SOFTWARE_VERSION}`;
  const dl = await signedGet(CDE, dlPath, r.device).catch((e) => ({ status: `error: ${e.message}`, buf: Buffer.alloc(0) }));
  const isMobi = dl.buf.length > 0x44 && dl.buf.subarray(0x3c, 0x44).toString('ascii') === 'BOOKMOBI';
  console.log(`    HTTP ${dl.status}`);
  if (dl.status === 200) {
    console.log(`    ${dl.buf.length} bytes; BOOKMOBI header: ${isMobi}; head: ${JSON.stringify(dl.buf.subarray(0, 32).toString('latin1'))}`);
  } else if (dl.buf.length) {
    console.log(`    ${dl.buf.toString('utf8').slice(0, 300)}`);
  }
  rl.close();
}

main().catch((e) => {
  console.error('error:', e);
  rl.close();
  process.exit(1);
});
