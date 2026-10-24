import type { Queryable } from '../db.js';

export interface Settings {
  kill_switch: { enabled: boolean; reason: string | null };
  default_country: string;
  daily_segment_budget: number;
  require_separate_approver: boolean;
  require_test_before_approval: boolean;
  delivery_report_timeout_hours: number;
  lease_seconds: number;
  max_campaign_recipients: number;
  retention: { messages_days: number; health_days: number; audit_days: number; sessions_days: number };
  test_numbers: string[];
  opt_out_keywords: string[];
  gateway_offline_minutes: number;
  retry_policy: { base_seconds: number; max_seconds: number };
  sending_confirm_grace_seconds: number;
}

export type SettingKey = keyof Settings;

export const SETTING_KEYS: SettingKey[] = [
  'kill_switch',
  'default_country',
  'daily_segment_budget',
  'require_separate_approver',
  'require_test_before_approval',
  'delivery_report_timeout_hours',
  'lease_seconds',
  'max_campaign_recipients',
  'retention',
  'test_numbers',
  'opt_out_keywords',
  'gateway_offline_minutes',
  'retry_policy',
  'sending_confirm_grace_seconds',
];

export async function getSetting<K extends SettingKey>(q: Queryable, key: K): Promise<Settings[K]> {
  const { rows } = await q.query<{ value: Settings[K] }>('SELECT value FROM app_settings WHERE key = $1', [key]);
  if (!rows[0]) throw new Error(`Setting ${key} missing; run migrations`);
  return rows[0].value;
}

export async function getAllSettings(q: Queryable): Promise<Settings> {
  const { rows } = await q.query<{ key: string; value: unknown }>(
    'SELECT key, value FROM app_settings WHERE key = ANY($1)',
    [SETTING_KEYS],
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value])) as unknown as Settings;
}
