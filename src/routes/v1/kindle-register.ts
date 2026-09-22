import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { secretsEnabled } from '../../crypto/secrets.js';
import { fetchTransport } from '../../connectors/registry.js';
import { upsertAccount } from '../../connectors/store.js';
import { registerDevice } from '../../connectors/kindle-fiona.js';
import type { HttpTransport } from '../../connectors/types.js';
import { credentialRequestIsSecure } from './connectors.js';

/**
 * OPTIONAL server-side Amazon device registration for the Kindle connector.
 * Mounted only when KINDLE_SERVER_REGISTRATION=true (self-host, single-user
 * installs). The Amazon password transits request memory only — it is never
 * stored, logged, or returned — and Amazon's emailed one-time code completes the
 * flow. The supported path for any multi-user install is the CrossPoint Kindle Link
 * browser extension (extension/), which keeps the password in the user's browser entirely.
 *
 * Flow: begin {email, password} -> Amazon emails a code -> complete {nonce, code}.
 * The nonce identifies an in-memory pending registration (10-min TTL); nothing
 * hits the database until registration succeeds and the scoped device credential
 * is stored encrypted like any connector credential.
 */

interface PendingRegistration {
  email: string;
  deviceSerial: string;
  expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const BEGIN_LIMIT_PER_HOUR = 10;

export function kindleRegisterRoutes(
  db: DB,
  transport: HttpTransport = fetchTransport,
  trustProxy = false
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const pending = new Map<string, PendingRegistration>();
  const beginAttempts = new Map<string, number[]>();

  function sweep(): void {
    const now = Date.now();
    for (const [nonce, p] of pending) if (p.expiresAt <= now) pending.delete(nonce);
    for (const [ip, tries] of beginAttempts) {
      const fresh = tries.filter((t) => now - t < 3_600_000);
      if (fresh.length === 0) beginAttempts.delete(ip);
      else beginAttempts.set(ip, fresh);
    }
  }

  // Socket address only, ignoring X-Forwarded-For: behind a proxy all clients
  // share one rate bucket, which is fine for this self-host single-user opt-in.
  function clientIp(c: Context<AppEnv>): string {
    return c.env?.incoming?.socket?.remoteAddress ?? 'unknown';
  }

  app.post('/connectors/kindle/register/begin', async (c) => {
    if (!credentialRequestIsSecure(c, trustProxy)) {
      return c.json({ code: 2003, message: 'Connector credentials require HTTPS' }, 400);
    }
    if (!secretsEnabled()) {
      return c.json({ code: 2003, message: 'Server has no TOKEN_ENC_KEY; connector storage disabled' }, 403);
    }
    sweep();
    const ip = clientIp(c);
    const tries = beginAttempts.get(ip) ?? [];
    if (tries.length >= BEGIN_LIMIT_PER_HOUR) {
      return c.json({ code: 2003, message: 'Too many registration attempts; try again later' }, 429);
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) return kosyncError(c, 403, 2003, 'Invalid request');
    tries.push(Date.now());
    beginAttempts.set(ip, tries);

    const result = await registerDevice(transport, { email, password }).catch((err) => {
      return { status: 'error' as const, message: err instanceof Error ? err.message : 'registration failed' };
    });
    if (result.status === 'error') {
      return c.json({ code: 2003, message: result.message }, 502);
    }
    if (result.status === 'otp_required') {
      const nonce = crypto.randomBytes(16).toString('hex');
      pending.set(nonce, {
        email,
        deviceSerial: result.deviceSerial,
        expiresAt: Date.now() + PENDING_TTL_MS,
      });
      return c.json({
        status: 'otp_required',
        nonce,
        message:
          'If the password was right, Amazon emailed a verification code; submit it to the complete ' +
          'endpoint within 10 minutes. No email means the password was wrong (Amazon answers both the same way).',
      });
    }
    // No OTP round needed (Amazon sometimes accepts the first attempt).
    const user = c.get('user');
    const { device } = result;
    upsertAccount(db, user.id, 'kindle', credentialFromDevice(device), device.deviceName);
    return c.json({ status: 'registered', linked: true, account: device.deviceName });
  });

  app.post('/connectors/kindle/register/complete', async (c) => {
    if (!credentialRequestIsSecure(c, trustProxy)) {
      return c.json({ code: 2003, message: 'Connector credentials require HTTPS' }, 400);
    }
    if (!secretsEnabled()) {
      return c.json({ code: 2003, message: 'Server has no TOKEN_ENC_KEY; connector storage disabled' }, 403);
    }
    sweep();
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const nonce = typeof body?.nonce === 'string' ? body.nonce : '';
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const entry = nonce ? pending.get(nonce) : undefined;
    if (!entry || !code) return kosyncError(c, 403, 2003, 'Invalid request');

    const result = await registerDevice(transport, {
      email: entry.email,
      password: code, // Amazon expects the emailed code ALONE in the password field
      deviceSerial: entry.deviceSerial,
    }).catch((err) => {
      return { status: 'error' as const, message: err instanceof Error ? err.message : 'registration failed' };
    });
    if (result.status === 'error') {
      return c.json({ code: 2003, message: result.message }, 502);
    }
    if (result.status === 'otp_required') {
      return c.json({ code: 2003, message: 'Amazon rejected that code. Start again.' }, 400);
    }
    pending.delete(nonce);
    const user = c.get('user');
    const { device } = result;
    upsertAccount(db, user.id, 'kindle', credentialFromDevice(device), device.deviceName);
    return c.json({ status: 'registered', linked: true, account: device.deviceName });
  });

  return app;
}

function credentialFromDevice(device: {
  adpToken: string;
  privateKey: string;
  deviceSerial: string;
  deviceName: string;
}): Record<string, unknown> {
  return {
    adp_token: device.adpToken,
    private_key: device.privateKey,
    device_serial: device.deviceSerial,
    device_name: device.deviceName,
  };
}
