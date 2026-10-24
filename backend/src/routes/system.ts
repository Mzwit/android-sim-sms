import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { getSetting } from '../lib/settings.js';
import { requirePerm } from '../auth/session.js';
import { BUDGET_TZ } from '../services/dispatch.js';
import { campaignProgress } from '../services/reports.js';
import { runRetention } from '../workers.js';
import { IdParams, actor } from './common.js';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const { db } = app.deps;

  app.get('/dashboard/summary', { preHandler: [app.authenticate], schema: { tags: ['dashboard'], summary: 'Overview numbers for the dashboard home page' } }, async () => {
    const offline = await getSetting(db, 'gateway_offline_minutes');
    const [contacts, campaigns, msgs, delivery, rate, gateways, today, alerts, running] = await Promise.all([
      db.query<{ total: number; valid: number; opted_out: number; consented: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE is_valid)::int AS valid,
                (SELECT count(*)::int FROM suppressions WHERE lifted_at IS NULL) AS opted_out,
                count(*) FILTER (WHERE (SELECT cr.status FROM consent_records cr WHERE cr.contact_id = c.id AND cr.purpose = 'general'
                                         ORDER BY cr.effective_at DESC, cr.recorded_at DESC LIMIT 1) = 'GRANTED')::int AS consented
           FROM contacts c WHERE deleted_at IS NULL`,
      ),
      db.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM campaigns GROUP BY 1`),
      db.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM messages WHERE NOT is_test GROUP BY 1`),
      db.query<{ delivery_state: string; n: number }>(`SELECT delivery_state, count(*)::int AS n FROM messages WHERE NOT is_test GROUP BY 1`),
      db.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE submitted_at > now() - interval '15 minutes'`),
      db.query<{ total: number; online: number; paused: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE last_seen_at > now() - make_interval(mins => $1))::int AS online,
                count(*) FILTER (WHERE is_paused)::int AS paused FROM gateways WHERE status = 'ACTIVE'`,
        [offline],
      ),
      db.query<{ segments: number; messages: number }>(
        `SELECT coalesce(sum(segments_submitted), 0)::int AS segments, coalesce(sum(messages_submitted), 0)::int AS messages
           FROM daily_usage WHERE usage_date = (now() AT TIME ZONE $1)::date`,
        [BUDGET_TZ],
      ),
      db.query<{ n: number; critical: number }>(`SELECT count(*)::int AS n, count(*) FILTER (WHERE severity = 'CRITICAL')::int AS critical FROM alerts WHERE acknowledged_at IS NULL`),
      db.query<{ id: string; name: string; status: string; pause_reason: string | null }>(
        `SELECT id, name, status, pause_reason FROM campaigns WHERE status IN ('RUNNING','PAUSED','SCHEDULED','APPROVED') ORDER BY created_at DESC LIMIT 10`,
      ),
    ]);
    const m = Object.fromEntries(msgs.rows.map((r) => [r.status, r.n]));
    const d = Object.fromEntries(delivery.rows.map((r) => [r.delivery_state, r.n]));
    const active = await Promise.all(running.rows.map(async (c) => ({ ...c, progress: await campaignProgress(db, c.id) })));
    const [kill, dailyBudget] = await Promise.all([getSetting(db, 'kill_switch'), getSetting(db, 'daily_segment_budget')]);
    return {
      contacts: contacts.rows[0],
      campaigns: { total: campaigns.rows.reduce((a, r) => a + r.n, 0), by_status: Object.fromEntries(campaigns.rows.map((r) => [r.status, r.n])) },
      messages: {
        queued: (m.QUEUED ?? 0) + (m.LEASED ?? 0) + (m.SENDING ?? 0),
        submitted: (m.SUBMITTED ?? 0) + (m.DELIVERED ?? 0),
        confirmed_delivered: m.DELIVERED ?? 0,
        failed: m.FAILED ?? 0,
        unknown: m.UNKNOWN ?? 0,
        cancelled: m.CANCELLED ?? 0,
        awaiting_report: d.AWAITING_REPORT ?? 0,
        no_report: d.NO_REPORT ?? 0,
      },
      rate_per_minute: Math.round((rate.rows[0]!.n / 15) * 10) / 10,
      gateways: gateways.rows[0],
      today: { ...today.rows[0], daily_segment_budget: dailyBudget },
      alerts: alerts.rows[0],
      kill_switch: kill,
      active_campaigns: active,
    };
  });

  app.get(
    '/alerts',
    { preHandler: [app.authenticate], schema: { tags: ['dashboard'], querystring: Type.Object({ open: Type.Optional(Type.Boolean({ default: true })) }) } },
    async (req) => {
      const open = req.query.open ?? true;
      const { rows } = await db.query(
        `SELECT a.id, a.created_at, a.severity, a.kind, a.message, a.entity_type, a.entity_id, a.acknowledged_at, ad.display_name AS acknowledged_by
           FROM alerts a LEFT JOIN administrators ad ON ad.id = a.acknowledged_by
          WHERE ${open ? 'a.acknowledged_at IS NULL' : 'TRUE'} ORDER BY a.created_at DESC LIMIT 200`,
      );
      return { items: rows };
    },
  );

  app.post('/alerts/:id/ack', { preHandler: [app.authenticate], schema: { tags: ['dashboard'], params: Type.Object({ id: Type.Integer({ minimum: 1 }) }) } }, async (req) => {
    const r = await db.query(`UPDATE alerts SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1 AND acknowledged_at IS NULL`, [req.params.id, req.admin!.id]);
    if (!r.rowCount) throw notFound('Open alert');
    await audit(db, { ...actor(req), action: 'alert.acknowledged', entityType: 'alert', entityId: req.params.id });
    return { ok: true };
  });

  app.post(
    '/maintenance/retention',
    {
      preHandler: [app.authenticate, requirePerm('settings.write')],
      schema: { tags: ['settings'], summary: 'Run the retention purge now (dry_run shows what would be deleted)', body: Type.Object({ dry_run: Type.Boolean() }, { additionalProperties: false }) },
    },
    async (req) => {
      const r = await runRetention(db, req.body.dry_run);
      if (!req.body.dry_run) await audit(db, { ...actor(req), action: 'retention.run_manually', details: { ...r } });
      return { dry_run: req.body.dry_run, deleted: r };
    },
  );

  app.get('/contacts/:id/messages', { preHandler: [app.authenticate, requirePerm('campaigns.read')], schema: { tags: ['contacts'], summary: 'Per-recipient message history', params: IdParams } }, async (req) => {
    const { rows } = await db.query(
      `SELECT m.id, m.campaign_id, c.name AS campaign_name, m.status, m.delivery_state, m.attempt_count, m.queued_at, m.submitted_at,
              m.delivered_at, m.last_error_code, m.last_error_category, m.is_test
         FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id WHERE m.contact_id = $1 ORDER BY m.created_at DESC LIMIT 200`,
      [req.params.id],
    );
    return { items: rows };
  });
};

export default routes;
