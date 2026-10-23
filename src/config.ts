export interface Config {
  /** URL prefix, empty for a domain-root deployment. */
  basePath: string;
  registrationDisabled: boolean;
  /** Max requests per IP per minute on sensitive endpoints (0 = disabled). */
  authRateLimitPerMinute: number;
  /** Trust the deployment's reverse proxy to set X-Forwarded-Proto. */
  trustProxy: boolean;
  /**
   * Origins allowed to call the sync API from a browser. '*' (the default)
   *   is safe because the API authenticates with headers, not cookies, so
   *   Access-Control-Allow-Credentials is never set.
   */
  corsOrigins: '*' | string[];
  /**
   * Self-host escape hatch: allow Amazon device registration THROUGH the server
   * (password transits memory, never stored). Off by default; NEVER enable on a
   * multi-user/hosted install — the setup CLI is the supported path there.
   */
  kindleServerRegistration: boolean;
}

export function fromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    basePath: normalizeBasePath(env.BASE_PATH ?? ''),
    registrationDisabled: env.REGISTRATION_DISABLED === 'true' || env.REGISTRATION_DISABLED === '1',
    authRateLimitPerMinute: env.AUTH_RATE_LIMIT_PER_MINUTE
      ? Number(env.AUTH_RATE_LIMIT_PER_MINUTE)
      : 30,
    // Railway always terminates TLS at its edge and sets RAILWAY_ENVIRONMENT,
    // so trust the proxy there by default; TRUST_PROXY still overrides both ways.
    trustProxy: env.TRUST_PROXY
      ? env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1'
      : Boolean(env.RAILWAY_ENVIRONMENT),
    corsOrigins: env.CORS_ORIGINS
      ? env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
      : '*',
    kindleServerRegistration:
      env.KINDLE_SERVER_REGISTRATION === 'true' || env.KINDLE_SERVER_REGISTRATION === '1',
  };
}

export function normalizeBasePath(value: string): string {
  if (value === '' || value === '/') return '';
  const path = value.replace(/\/+$/, '');
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/.test(path)
    || path.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('BASE_PATH must be an absolute path of URL-safe segments (for example /reading)');
  }
  return path;
}
