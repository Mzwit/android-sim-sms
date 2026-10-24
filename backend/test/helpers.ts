import { randomUUID } from 'node:crypto';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://smsgw:devpass@localhost:5432/smsgw_test';
export const PASSWORD = 'Correct-Horse-Battery-9';

export async function makeApp(overrides: Partial<Config> = {}) {
  const config: Config = {
    ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: TEST_DB_URL, LOG_LEVEL: 'silent' }),
    enableDocs: true,
    apiRateLimitPerMinute: 100_000,
    loginRateLimitPerMinute: 100_000,
    ...overrides,
  };
  const db = createPool(TEST_DB_URL, 10);
  const app = await buildApp({ config, db });
  await app.ready();
  return { app, db, config };
}

/** Wipe all data except reference tables (roles/permissions) and reset settings to defaults. */
export async function resetDb(db: Db) {
  // TRUNCATE does not fire row-level triggers, so the audit append-only guard does not block it.
  await db.query(`TRUNCATE administrators, admin_sessions, gateways, gateway_pairing_codes, gateway_credentials,
    gateway_health_events, contacts, contact_groups, group_memberships, consent_records, suppressions, campaigns,
    campaign_groups, campaign_schedules, campaign_recipients, messages, sms_submission_attempts, delivery_reports,
    retry_jobs, reconciliations, daily_usage, idempotency_keys, audit_logs RESTART IDENTITY CASCADE`);
  // app_settings.updated_by references administrators, so the CASCADE above emptied it: restore defaults.
  await db.query(`INSERT INTO app_settings (key, value) VALUES
    ('kill_switch', '{"enabled": false, "reason": null}'), ('default_country', '"SZ"'),
    ('daily_segment_budget', '2000'), ('require_separate_approver', 'false'),
    ('require_test_before_approval', 'true'), ('delivery_report_timeout_hours', '48'),
    ('lease_seconds', '300'), ('max_campaign_recipients', '20000'),
    ('retention', '{"messages_days": 365, "health_days": 30, "audit_days": 1095, "sessions_days": 30}'),
    ('test_numbers', '[]')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = NULL`);
}

export async function createAdmin(db: Db, role = 'SUPER_ADMIN', opts: { mustChange?: boolean; email?: string } = {}) {
  const email = opts.email ?? `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@example.org`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO administrators (email, display_name, password_hash, role_id, must_change_password)
     VALUES ($1, $2, $3, (SELECT id FROM roles WHERE code = $4), $5) RETURNING id`,
    [email, `Test ${role}`, await hashPassword(PASSWORD), role, opts.mustChange ?? false],
  );
  return { id: rows[0]!.id, email };
}

type App = Awaited<ReturnType<typeof makeApp>>['app'];

export async function login(app: App, email: string, password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  return res.json().token as string;
}

/** Admin with a bearer token, ready to call the API. */
export async function adminClient(app: App, db: Db, role = 'SUPER_ADMIN') {
  const a = await createAdmin(db, role);
  const token = await login(app, a.email);
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: { authorization: `Bearer ${token}`, ...headers } });
  return { ...a, token, call };
}

let phoneCounter = 0;
/** Unique, valid Eswatini mobile number for tests. */
export function testPhone(): string {
  phoneCounter++;
  return `${['76', '78', '79'][phoneCounter % 3]}${String(100000 + phoneCounter).slice(-6)}`;
}
