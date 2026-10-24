import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import QRCode from 'qrcode';
import { randomBytes } from 'node:crypto';
import { withTx } from '../db.js';
import { audit } from '../lib/audit.js';
import { sha256 } from '../lib/crypto.js';
import { notFound } from '../lib/errors.js';
import { getSetting } from '../lib/settings.js';
import { certFingerprint } from '../lib/tls.js';
import { requirePerm } from '../auth/session.js';
import { BUDGET_TZ } from '../services/dispatch.js';
import { IdParams, actor } from './common.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function pairingCode(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out; // 10 chars ≈ 50 bits; single use, expires in 10 minutes, rate-limited
}

function serverUrl(req: FastifyRequest, configured?: string): string {
  if (configured) return configured;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol;
  return `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
}

export const GATEWAY_LIST_SQL = `
SELECT g.id, g.name, g.status, g.device_model, g.android_version, g.app_version,
       g.sim_subscription_id, g.sim_slot_index, g.sim_display_name, g.sim_carrier_name,
       g.is_paused, g.pause_reason, g.emergency_stop_at, g.send_interval_ms, g.batch_limit,
       g.last_seen_at, g.last_health, g.created_at,
       (g.last_seen_at > now() - make_interval(mins => $1)) AS online,
       coalesce(u.segments_submitted, 0) AS segments_today, coalesce(u.messages_submitted, 0) AS messages_today,
       (SELECT count(*)::int FROM messages m WHERE m.gateway_id = g.id AND m.status IN ('LEASED','SENDING')) AS in_flight
  FROM gateways g
  LEFT JOIN daily_usage u ON u.gateway_id = g.id AND u.usage_date = (now() AT TIME ZONE '${BUDGET_TZ}')::date`;

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const { db, config } = app.deps;
  const read = [app.authenticate, requirePerm('gateways.read')];
  const manage = [app.authenticate, requirePerm('gateways.manage')];

  app.get('/gateways', { preHandler: read, schema: { tags: ['gateways'], summary: 'Paired phones with health and today’s usage' } }, async () => {
    const offline = await getSetting(db, 'gateway_offline_minutes');
    const { rows } = await db.query(`${GATEWAY_LIST_SQL} WHERE g.status <> 'REVOKED' ORDER BY g.created_at`, [offline]);
    return { items: rows, daily_segment_budget: await getSetting(db, 'daily_segment_budget') };
  });

  app.get(
    '/gateways/:id/health',
    {
      preHandler: read,
      schema: { tags: ['gateways'], params: IdParams, querystring: Type.Object({ hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720, default: 24 })) }) },
    },
    async (req) => {
      const { rows } = await db.query(
        `SELECT received_at, recorded_at, kind, battery_pct, is_charging, signal_level, signal_dbm, network_type, service_state, sim_state, queue_pending
           FROM gateway_health_events WHERE gateway_id = $1 AND received_at > now() - make_interval(hours => $2)
          ORDER BY received_at DESC LIMIT 2000`,
        [req.params.id, req.query.hours ?? 24],
      );
      const errors = await db.query(
        `SELECT a.reported_at, a.error_code, a.error_category, a.detail, m.campaign_id
           FROM sms_submission_attempts a JOIN messages m ON m.id = a.message_id
          WHERE a.gateway_id = $1 AND a.outcome IN ('FAILED','UNKNOWN') ORDER BY a.reported_at DESC NULLS LAST LIMIT 50`,
        [req.params.id],
      );
      return { events: rows, recent_errors: errors.rows };
    },
  );

  app.post(
    '/gateways/pairing-codes',
    {
      preHandler: manage,
      schema: {
        tags: ['gateways'],
        summary: 'Create a one-time pairing code and QR for a new phone (valid 10 minutes)',
        body: Type.Object({ label: Type.String({ minLength: 1, maxLength: 60 }) }, { additionalProperties: false }),
      },
    },
    async (req, reply) => {
      const code = pairingCode();
      const expires = new Date(Date.now() + 10 * 60_000);
      await withTx(db, async (tx) => {
        await tx.query(
          `INSERT INTO gateway_pairing_codes (code_hash, label, created_by, expires_at) VALUES ($1, $2, $3, $4)`,
          [sha256(code), req.body.label.trim(), req.admin!.id, expires],
        );
        await audit(tx, { ...actor(req), action: 'gateway.pairing_code_created', entityType: 'gateway', details: { label: req.body.label } });
      });
      const url = serverUrl(req, config.publicUrl);
      const fingerprint = certFingerprint(config.tlsCertPath);
      const payload = JSON.stringify({ v: 1, url, code, fp: fingerprint });
      const qr = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
      reply.code(201);
      return {
        code: code.replace(/(.{5})/, '$1-'),
        expires_at: expires.toISOString(),
        server_url: url,
        certificate_fingerprint: fingerprint,
        qr_payload: payload,
        qr_data_url: qr,
        warning: url.startsWith('http://') && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(url) ? 'Server URL is plain HTTP. Pairing will be refused by the app except over USB (adb reverse to 127.0.0.1).' : undefined,
      };
    },
  );

  app.patch(
    '/gateways/:id',
    {
      preHandler: manage,
      schema: {
        tags: ['gateways'],
        summary: 'Rename or change pacing. Interval is a floor; the phone never sends faster.',
        params: IdParams,
        body: Type.Object(
          {
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
            send_interval_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600_000 })),
            batch_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) =>
      withTx(db, async (tx) => {
        const r = await tx.query(
          `UPDATE gateways SET name = coalesce($2, name), send_interval_ms = coalesce($3, send_interval_ms), batch_limit = coalesce($4, batch_limit)
            WHERE id = $1 RETURNING id, name, send_interval_ms, batch_limit`,
          [req.params.id, req.body.name ?? null, req.body.send_interval_ms ?? null, req.body.batch_limit ?? null],
        );
        if (!r.rows[0]) throw notFound('Gateway');
        await audit(tx, { ...actor(req), action: 'gateway.updated', entityType: 'gateway', entityId: req.params.id, details: req.body });
        return r.rows[0];
      }),
  );

  const control = (path: string, action: string, sql: string, summary: string) =>
    app.post(
      `/gateways/:id/${path}`,
      {
        preHandler: [app.authenticate, requirePerm(path === 'resume' || path === 'pause' ? 'campaigns.operate' : 'gateways.manage')],
        schema: { tags: ['gateways'], summary, params: IdParams, body: Type.Object({ reason: Type.String({ minLength: 3, maxLength: 300 }) }, { additionalProperties: false }) },
      },
      async (req) =>
        withTx(db, async (tx) => {
          const r = await tx.query(sql, [req.params.id, req.body.reason]);
          if (!r.rowCount) throw notFound('Gateway');
          if (path === 'revoke') {
            await tx.query('UPDATE gateway_credentials SET revoked_at = now() WHERE gateway_id = $1 AND revoked_at IS NULL', [req.params.id]);
            // Unconfirmed leases are provably unsent: requeue them now.
            await tx.query(
              `UPDATE sms_submission_attempts SET outcome = 'NOT_SENT', detail = 'GATEWAY_REVOKED', reported_at = now()
                WHERE gateway_id = $1 AND outcome = 'PENDING' AND confirmed_at IS NULL`,
              [req.params.id],
            );
            await tx.query(
              `UPDATE messages SET status = 'QUEUED', lease_id = NULL, leased_at = NULL, lease_expires_at = NULL, gateway_id = NULL
                WHERE gateway_id = $1 AND status = 'LEASED'`,
              [req.params.id],
            );
          }
          await audit(tx, { ...actor(req), action, entityType: 'gateway', entityId: req.params.id, details: { reason: req.body.reason } });
          return { ok: true };
        }),
    );

  control('pause', 'gateway.paused', `UPDATE gateways SET is_paused = true, pause_reason = $2 WHERE id = $1 AND status = 'ACTIVE'`, 'Stop leasing new messages to this phone');
  control('resume', 'gateway.resumed', `UPDATE gateways SET is_paused = false, pause_reason = NULL, emergency_stop_at = NULL WHERE id = $1 AND status = 'ACTIVE' AND $2::text IS NOT NULL`, 'Resume (also clears an emergency stop)');
  control(
    'emergency-stop',
    'gateway.emergency_stop',
    `UPDATE gateways SET is_paused = true, emergency_stop_at = now(), pause_reason = $2 WHERE id = $1`,
    'Emergency stop: the phone drops every unsent leased message at its next contact',
  );
  control('revoke', 'gateway.revoked', `UPDATE gateways SET status = 'REVOKED', revoked_at = now(), is_paused = true, pause_reason = $2 WHERE id = $1 AND status <> 'REVOKED'`, 'Permanently unpair this phone');
};

export default routes;
