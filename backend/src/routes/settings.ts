import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { withTx } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { isValidCountry, normalizePhone } from '../lib/phone.js';
import { getAllSettings, getSetting, type SettingKey } from '../lib/settings.js';
import { requirePerm } from '../auth/session.js';
import { actor } from './common.js';

const SETTING_SCHEMAS: Record<Exclude<SettingKey, 'kill_switch'>, TSchema> = {
  default_country: Type.String({ pattern: '^[A-Z]{2}$' }),
  daily_segment_budget: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  require_separate_approver: Type.Boolean(),
  require_test_before_approval: Type.Boolean(),
  delivery_report_timeout_hours: Type.Integer({ minimum: 1, maximum: 24 * 14 }),
  lease_seconds: Type.Integer({ minimum: 60, maximum: 3600 }),
  max_campaign_recipients: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  retention: Type.Object(
    {
      messages_days: Type.Integer({ minimum: 7, maximum: 3650 }),
      health_days: Type.Integer({ minimum: 1, maximum: 365 }),
      audit_days: Type.Integer({ minimum: 90, maximum: 3650 }),
      sessions_days: Type.Integer({ minimum: 1, maximum: 365 }),
    },
    { additionalProperties: false },
  ),
  test_numbers: Type.Array(Type.String({ maxLength: 40 }), { maxItems: 20 }),
};

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const { db } = app.deps;

  app.get('/settings', { preHandler: [app.authenticate], schema: { tags: ['settings'], summary: 'All application settings' } }, async () =>
    getAllSettings(db),
  );

  app.put(
    '/settings/:key',
    {
      preHandler: [app.authenticate, requirePerm('settings.write')],
      schema: {
        tags: ['settings'],
        summary: 'Change one setting (the kill switch has its own endpoint)',
        params: Type.Object({ key: Type.String({ pattern: '^[a-z_]+$' }) }),
        body: Type.Object({ value: Type.Unknown() }, { additionalProperties: false }),
      },
    },
    async (req) => {
      const key = req.params.key as Exclude<SettingKey, 'kill_switch'>;
      const schema = SETTING_SCHEMAS[key];
      if (!schema) throw notFound(`Setting ${req.params.key}`);
      let value = req.body.value;
      if (!Value.Check(schema, value)) {
        throw badRequest('INVALID_SETTING', `Invalid value for ${key}`, [...Value.Errors(schema, value)].slice(0, 5).map((e) => e.message));
      }
      if (key === 'default_country' && !isValidCountry(value as string)) throw badRequest('INVALID_SETTING', 'Unknown country code');
      if (key === 'test_numbers') {
        // Store authorised test numbers normalised; reject any that do not validate.
        const country = await getSetting(db, 'default_country');
        const out: string[] = [];
        for (const raw of value as string[]) {
          const n = normalizePhone(raw, country);
          if (!n.ok) throw badRequest('INVALID_SETTING', `Test number "${raw}": ${n.message}`);
          if (!out.includes(n.e164)) out.push(n.e164);
        }
        value = out;
      }
      return withTx(db, async (tx) => {
        const before = await tx.query('SELECT value FROM app_settings WHERE key = $1 FOR UPDATE', [key]);
        await tx.query('UPDATE app_settings SET value = $2, updated_by = $3, updated_at = now() WHERE key = $1', [key, JSON.stringify(value), req.admin!.id]);
        await audit(tx, { ...actor(req), action: 'settings.changed', entityType: 'setting', entityId: key, details: { before: before.rows[0]?.value, after: value } });
        return { key, value };
      });
    },
  );

  app.post(
    '/kill-switch',
    {
      preHandler: [app.authenticate, requirePerm('settings.write')],
      schema: {
        tags: ['settings'],
        summary: 'Engage or release the global kill switch. While engaged, no new messages are handed to any phone.',
        body: Type.Object(
          { enabled: Type.Boolean(), reason: Type.String({ minLength: 3, maxLength: 300 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (req) =>
      withTx(db, async (tx) => {
        const value = { enabled: req.body.enabled, reason: req.body.reason, changed_at: new Date().toISOString(), changed_by: req.admin!.id };
        await tx.query(`UPDATE app_settings SET value = $1, updated_by = $2, updated_at = now() WHERE key = 'kill_switch'`, [JSON.stringify(value), req.admin!.id]);
        await audit(tx, { ...actor(req), action: req.body.enabled ? 'kill_switch.engaged' : 'kill_switch.released', entityType: 'setting', entityId: 'kill_switch', details: { reason: req.body.reason } });
        return value;
      }),
  );
};

export default routes;
