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
    gatewayRateLimitPerMinute: 1_000_000,
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
    campaign_groups, campaign_schedules, campaign_recipients, messages, sms_submission_attempts, sms_part_results, delivery_reports,
    retry_jobs, reconciliations, daily_usage, idempotency_keys, audit_logs, contact_imports, contact_import_rows, alerts
    RESTART IDENTITY CASCADE`);
  // app_settings.updated_by references administrators, so the CASCADE above emptied it: restore defaults.
  await db.query(`INSERT INTO app_settings (key, value) SELECT key, value FROM _test_settings_defaults
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = NULL`);
  await db.query(`DELETE FROM app_settings WHERE key NOT IN (SELECT key FROM _test_settings_defaults)`);
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

import type { Call } from '../src/sim/simulator.js';
import { GatewaySimulator, DEFAULT_POLICY, type SimPolicy } from '../src/sim/simulator.js';

/** Adapter: the simulator talks to the in-process app via inject(). */
export function injectCall(app: App): Call {
  return async (method, path, body, token) => {
    const res = await app.inject({ method, url: path, payload: body as never, headers: token ? { authorization: `Gateway ${token}` } : {} });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
}

type Client = Awaited<ReturnType<typeof adminClient>>;

export async function pairSimulator(app: App, admin: Client, opts: { policy?: Partial<SimPolicy>; seed?: number; name?: string; fast?: boolean } = {}) {
  const pc = await admin.call('POST', '/gateways/pairing-codes', { label: opts.name ?? 'Sim phone' });
  if (pc.statusCode !== 201) throw new Error(pc.body);
  const sim = new GatewaySimulator(injectCall(app), { ...DEFAULT_POLICY, transientFailure: 0, permanentFailure: 0, unknown: 0, deliveryReport: 1, deliveryFailure: 0, duplicateEvents: 0, ...opts.policy }, opts.seed ?? 1, opts.name ?? 'sim');
  await sim.pair(pc.json().code);
  if (opts.fast !== false) {
    await admin.call('PATCH', `/gateways/${sim.gatewayId}`, { send_interval_ms: 1000, batch_limit: 200 });
  }
  return sim;
}

/**
 * Bulk-create N consented contacts in a new group, directly in SQL (fast enough for 6,000+).
 * Numbers are +2687600xxxx style and tagged LOADTEST.
 */
let bulkCounter = 0;
export async function bulkContacts(db: Db, n: number, opts: { consent?: boolean } = {}) {
  if (n > 100_000) throw new Error('n too large');
  const g = await db.query<{ id: string }>(`INSERT INTO contact_groups (name) VALUES ($1) RETURNING id`, [`Bulk ${randomUUID().slice(0, 8)}`]);
  const groupId = g.rows[0]!.id;
  const block = bulkCounter++ % 9; // 9 blocks of 100,000 numbers in +268 76/78/79 xxxxxx
  const prefix = ['76', '78', '79'][block % 3]!;
  const base = Math.floor(block / 3) * 300_000 + 100_000;
  const r = await db.query(
    `WITH ins AS (
       INSERT INTO contacts (phone_e164, phone_raw, is_valid, first_name, last_name, reference_no, tags)
       SELECT '+268' || $2 || lpad(($3 + i)::text, 6, '0'), 'bulk', true, 'P' || i, 'Bulk', 'R' || i, ARRAY['LOADTEST']
         FROM generate_series(1, $1) i
       ON CONFLICT DO NOTHING RETURNING id)
     , gm AS (INSERT INTO group_memberships (group_id, contact_id) SELECT $4, id FROM ins)
     , cr AS (INSERT INTO consent_records (contact_id, status, source) SELECT id, 'GRANTED', 'bulk test' FROM ins WHERE $5)
     SELECT count(*)::int AS n FROM ins`,
    [n, prefix, base, groupId, opts.consent !== false],
  );
  if (r.rows[0].n !== n) throw new Error(`bulkContacts created ${r.rows[0].n} of ${n}`);
  return groupId;
}

/** Create, test (if required), submit, approve and start a campaign. Returns its id. */
export async function runningCampaign(admin: Client, db: Db, groupId: string, extra: Record<string, unknown> = {}) {
  await db.query(`UPDATE app_settings SET value = 'false' WHERE key = 'require_test_before_approval'`);
  const name = `C-${randomUUID().slice(0, 6)}`;
  const c = await admin.call('POST', '/campaigns', { name, body_template: 'Hello {{first_name}}, this is a test.', group_ids: [groupId], schedule: { window_start: '00:00', window_end: '23:59', days_of_week: [1, 2, 3, 4, 5, 6, 7] }, ...extra }, { 'idempotency-key': randomUUID() });
  if (c.statusCode !== 201) throw new Error(c.body);
  const id = c.json().id;
  for (const [path, body] of [[`/campaigns/${id}/submit`, undefined], [`/campaigns/${id}/approve`, { confirm_name: name }], [`/campaigns/${id}/start`, undefined]] as const) {
    const r = await admin.call('POST', path, body);
    if (r.statusCode !== 200) throw new Error(`${path}: ${r.body}`);
  }
  return id as string;
}
