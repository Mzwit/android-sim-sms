import 'dotenv/config';

/** Typed, validated configuration. The process refuses to start on bad config. */
export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  host: string;
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
  logLevel: string;
  sessionTtlHours: number;
  cookieSecure: boolean;
  trustProxy: boolean;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  corsOrigin?: string;
  loginMaxAttempts: number;
  loginLockMinutes: number;
  apiRateLimitPerMinute: number;
  loginRateLimitPerMinute: number;
  gatewayRateLimitPerMinute: number;
  enableDocs: boolean;
  /** Public base URL phones use to reach this server (QR code). */
  publicUrl?: string;
  /** Create this super admin at startup if no administrator exists (temporary password is logged once). */
  bootstrapAdminEmail?: string;
  bootstrapAdminName?: string;
  /** Directory with the built dashboard (served at /). */
  dashboardDir?: string;
  /** Run background workers (lease sweeper, scheduler, retention) in this process. */
  runWorkers: boolean;
  /** Allow approving campaigns that contain SEED_DATA contacts (simulator/load tests only). */
  allowSeedCampaigns: boolean;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v || !v.trim()) throw new Error(`Missing required environment variable ${key}`);
  return v.trim();
}

function int(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${key} must be true/false (got "${raw}")`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = (env.NODE_ENV ?? 'development') as Config['nodeEnv'];
  if (!['development', 'production', 'test'].includes(nodeEnv)) {
    throw new Error(`NODE_ENV must be development, production or test`);
  }
  const tlsCertPath = env.TLS_CERT_PATH?.trim() || undefined;
  const tlsKeyPath = env.TLS_KEY_PATH?.trim() || undefined;
  if (Boolean(tlsCertPath) !== Boolean(tlsKeyPath)) {
    throw new Error('Set both TLS_CERT_PATH and TLS_KEY_PATH, or neither');
  }
  const databaseUrl = nodeEnv === 'test' ? (env.TEST_DATABASE_URL ?? req(env, 'DATABASE_URL')) : req(env, 'DATABASE_URL');
  const cfg: Config = {
    nodeEnv,
    host: env.HOST?.trim() || '127.0.0.1',
    port: int(env, 'PORT', 8443, 1, 65535),
    databaseUrl,
    dbPoolMax: int(env, 'DB_POOL_MAX', 10, 1, 100),
    logLevel: env.LOG_LEVEL?.trim() || (nodeEnv === 'test' ? 'silent' : 'info'),
    sessionTtlHours: int(env, 'SESSION_TTL_HOURS', 12, 1, 24 * 30),
    cookieSecure: bool(env, 'COOKIE_SECURE', Boolean(tlsCertPath)),
    trustProxy: bool(env, 'TRUST_PROXY', false),
    tlsCertPath,
    tlsKeyPath,
    corsOrigin: env.CORS_ORIGIN?.trim() || undefined,
    loginMaxAttempts: int(env, 'LOGIN_MAX_ATTEMPTS', 5, 1, 50),
    loginLockMinutes: int(env, 'LOGIN_LOCK_MINUTES', 15, 1, 24 * 60),
    apiRateLimitPerMinute: int(env, 'API_RATE_LIMIT_PER_MINUTE', 300, 10, 100_000),
    loginRateLimitPerMinute: int(env, 'LOGIN_RATE_LIMIT_PER_MINUTE', 10, 1, 100_000),
    // A phone sending 1 SMS/second makes ~3 requests/second; 600/min leaves headroom.
    gatewayRateLimitPerMinute: int(env, 'GATEWAY_RATE_LIMIT_PER_MINUTE', 600, 60, 1_000_000),
    enableDocs: bool(env, 'ENABLE_API_DOCS', nodeEnv !== 'production'),
    publicUrl: (env.PUBLIC_URL?.trim() || env.RENDER_EXTERNAL_URL?.trim() || undefined)?.replace(/\/+$/, ''),
    bootstrapAdminEmail: env.BOOTSTRAP_ADMIN_EMAIL?.trim() || undefined,
    bootstrapAdminName: env.BOOTSTRAP_ADMIN_NAME?.trim() || undefined,
    dashboardDir: env.DASHBOARD_DIR?.trim() || undefined,
    runWorkers: bool(env, 'RUN_WORKERS', nodeEnv !== 'test'),
    allowSeedCampaigns: bool(env, 'ALLOW_SEED_CAMPAIGNS', false),
  };
  if (cfg.nodeEnv === 'production' && !cfg.tlsCertPath && !cfg.trustProxy) {
    // Allowed (e.g. behind a TLS reverse proxy), but loudly flagged at startup.
    process.emitWarning('Running in production without TLS_CERT_PATH: traffic is unencrypted unless a TLS proxy is in front.');
  }
  return cfg;
}
