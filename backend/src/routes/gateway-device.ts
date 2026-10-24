/**
 * Endpoints called by the Android app. Authenticated with
 *   Authorization: Gateway <device token>
 * The phone always connects out to the server; the server never calls the phone.
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { withTx, type Queryable } from '../db.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { getSetting } from '../lib/settings.js';
import { makeAuthenticateGateway } from '../auth/gateway-auth.js';
import { applyEvents, confirmSend, leaseJobs, loadGateway, releaseAttempts, type GatewayEvent } from '../services/dispatch.js';
import { Uuid } from './common.js';

export const APP_PROTOCOL_VERSION = 1;

export async function gatewayConfig(q: Queryable, gatewayId: string) {
  const gw = await loadGateway(q, gatewayId);
  if (!gw) throw new AppError(404, 'NOT_FOUND', 'Gateway not found');
  const [kill, testNumbers, keywords, leaseSeconds] = await Promise.all([
    getSetting(q, 'kill_switch'),
    getSetting(q, 'test_numbers'),
    getSetting(q, 'opt_out_keywords'),
    getSetting(q, 'lease_seconds'),
  ]);
  return {
    protocol: APP_PROTOCOL_VERSION,
    gateway_id: gw.id,
    name: gw.name,
    status: gw.status,
    paused: gw.is_paused,
    pause_reason: gw.pause_reason,
    emergency_stop: Boolean(gw.emergency_stop_at),
    kill_switch: kill.enabled,
    kill_switch_reason: kill.enabled ? kill.reason : null,
    send_interval_ms: gw.send_interval_ms,
    batch_limit: gw.batch_limit,
    lease_seconds: leaseSeconds,
    sim_subscription_id: gw.sim_subscription_id,
    test_numbers: testNumbers,
    opt_out_keywords: keywords,
    heartbeat_interval_ms: 60_000,
    server_time: new Date().toISOString(),
  };
}

const EventSchema = Type.Union([
  Type.Object({ id: Type.String({ maxLength: 64 }), type: Type.Literal('PART_SENT'), attempt_id: Uuid, part_index: Type.Integer({ minimum: 0, maximum: 20 }), parts_total: Type.Integer({ minimum: 1, maximum: 20 }), result_code: Type.Integer(), at: Type.Optional(Type.String({ maxLength: 40 })) }),
  Type.Object({ id: Type.String({ maxLength: 64 }), type: Type.Literal('SEND_ERROR'), attempt_id: Uuid, app_code: Type.String({ maxLength: 40 }), detail: Type.Optional(Type.String({ maxLength: 300 })), at: Type.Optional(Type.String({ maxLength: 40 })) }),
  Type.Object({ id: Type.String({ maxLength: 64 }), type: Type.Literal('SUBMIT_UNKNOWN'), attempt_id: Uuid, app_code: Type.String({ maxLength: 40 }), at: Type.Optional(Type.String({ maxLength: 40 })) }),
  Type.Object({ id: Type.String({ maxLength: 64 }), type: Type.Literal('NOT_SENT'), attempt_id: Uuid, reason: Type.String({ maxLength: 100 }), at: Type.Optional(Type.String({ maxLength: 40 })) }),
  Type.Object({ id: Type.String({ maxLength: 64 }), type: Type.Literal('DELIVERY'), attempt_id: Uuid, part_index: Type.Integer({ minimum: 0, maximum: 20 }), tp_status: Type.Integer({ minimum: 0, maximum: 255 }), at: Type.Optional(Type.String({ maxLength: 40 })) }),
  Type.Object({ id: Type.String({ maxLength: 64 }), type: Type.Literal('INBOUND'), from: Type.String({ maxLength: 40 }), body: Type.String({ maxLength: 500 }), at: Type.Optional(Type.String({ maxLength: 40 })) }),
  Type.Object({ id: Type.String({ maxLength: 64 }), type: Type.Literal('DIAGNOSTIC_SMS'), to: Type.String({ maxLength: 40 }), result_code: Type.Union([Type.Integer(), Type.Null()]), app_code: Type.Optional(Type.String({ maxLength: 40 })), at: Type.Optional(Type.String({ maxLength: 40 })) }),
]);

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const { db } = app.deps;
  const authGw = makeAuthenticateGateway(db);
  const gwRate = { rateLimit: { max: app.deps.config.gatewayRateLimitPerMinute, timeWindow: '1 minute', keyGenerator: (req: { headers: Record<string, unknown>; ip: string }) => String(req.headers.authorization ?? req.ip) } };

  app.post(
    '/gateway/pair',
    {
      config: { rateLimit: { max: app.deps.config.loginRateLimitPerMinute, timeWindow: '1 minute' } },
      schema: {
        tags: ['gateway (phone)'],
        summary: 'Exchange a one-time pairing code (from the dashboard QR) for a device token',
        security: [],
        body: Type.Object(
          {
            code: Type.String({ minLength: 6, maxLength: 20 }),
            device_model: Type.Optional(Type.String({ maxLength: 100 })),
            android_version: Type.Optional(Type.String({ maxLength: 20 })),
            app_version: Type.Optional(Type.String({ maxLength: 20 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const code = req.body.code.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const result = await withTx(db, async (tx) => {
        const { rows } = await tx.query<{ id: string; label: string; expires_at: Date; used_at: Date | null; created_by: string }>(
          `SELECT id, label, expires_at, used_at, created_by FROM gateway_pairing_codes WHERE code_hash = $1 FOR UPDATE`,
          [sha256(code)],
        );
        const pc = rows[0];
        if (!pc || pc.used_at || pc.expires_at.getTime() < Date.now()) {
          await audit(tx, { actorType: 'SYSTEM', action: 'gateway.pair_failed', ip: req.ip, details: { reason: !pc ? 'unknown_code' : pc.used_at ? 'used' : 'expired' } });
          return undefined;
        }
        const gw = await tx.query<{ id: string }>(
          `INSERT INTO gateways (name, device_model, android_version, app_version) VALUES ($1, $2, $3, $4) RETURNING id`,
          [pc.label, req.body.device_model ?? null, req.body.android_version ?? null, req.body.app_version ?? null],
        );
        const gatewayId = gw.rows[0]!.id;
        const token = randomToken(32);
        await tx.query('INSERT INTO gateway_credentials (gateway_id, token_hash) VALUES ($1, $2)', [gatewayId, sha256(token)]);
        await tx.query('UPDATE gateway_pairing_codes SET used_at = now(), gateway_id = $2 WHERE id = $1', [pc.id, gatewayId]);
        await audit(tx, {
          actorType: 'GATEWAY',
          actorId: gatewayId,
          action: 'gateway.paired',
          entityType: 'gateway',
          entityId: gatewayId,
          ip: req.ip,
          details: { label: pc.label, device_model: req.body.device_model, approved_by: pc.created_by },
        });
        return { token, config: await gatewayConfig(tx, gatewayId) };
      });
      // Constant response for every failure reason (no oracle for guessing codes).
      if (!result) throw new AppError(400, 'PAIRING_FAILED', 'Pairing code is invalid, expired or already used');
      reply.code(201);
      return result;
    },
  );

  app.post(
    '/gateway/heartbeat',
    {
      preHandler: authGw,
      config: gwRate,
      schema: {
        tags: ['gateway (phone)'],
        summary: 'Report health; receive current configuration and commands',
        body: Type.Object({
          recorded_at: Type.Optional(Type.String({ maxLength: 40 })),
          kind: Type.Optional(Type.Union(['HEARTBEAT', 'SIM_CHANGED', 'PERMISSION_LOST', 'SERVICE_STARTED', 'SERVICE_STOPPED', 'EMERGENCY_STOP', 'ERROR'].map((k) => Type.Literal(k)))),
          battery_pct: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()])),
          is_charging: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
          signal_level: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 4 }), Type.Null()])),
          signal_dbm: Type.Optional(Type.Union([Type.Integer({ minimum: -200, maximum: 0 }), Type.Null()])),
          network_type: Type.Optional(Type.Union([Type.String({ maxLength: 30 }), Type.Null()])),
          service_state: Type.Optional(Type.Union([Type.String({ maxLength: 30 }), Type.Null()])),
          sim_state: Type.Optional(Type.Union([Type.String({ maxLength: 30 }), Type.Null()])),
          queue_pending: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
          service_running: Type.Optional(Type.Boolean()),
          permissions: Type.Optional(Type.Record(Type.String({ maxLength: 60 }), Type.Boolean())),
          app_version: Type.Optional(Type.String({ maxLength: 20 })),
          details: Type.Optional(Type.Record(Type.String({ maxLength: 60 }), Type.Unknown())),
        }),
      },
    },
    async (req) => {
      const b = req.body;
      const gw = req.gateway!;
      const health = {
        battery_pct: b.battery_pct ?? null,
        is_charging: b.is_charging ?? null,
        signal_level: b.signal_level ?? null,
        signal_dbm: b.signal_dbm ?? null,
        network_type: b.network_type ?? null,
        service_state: b.service_state ?? null,
        sim_state: b.sim_state ?? null,
        queue_pending: b.queue_pending ?? null,
        service_running: b.service_running ?? null,
        permissions: b.permissions ?? null,
        received_at: new Date().toISOString(),
      };
      const recorded = b.recorded_at && !Number.isNaN(Date.parse(b.recorded_at)) ? new Date(b.recorded_at) : new Date();
      await db.query(
        `INSERT INTO gateway_health_events (gateway_id, recorded_at, kind, battery_pct, is_charging, signal_level, signal_dbm,
                                            network_type, service_state, sim_state, queue_pending, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [gw.id, recorded, String(b.kind ?? 'HEARTBEAT'), health.battery_pct, health.is_charging, health.signal_level, health.signal_dbm,
         health.network_type, health.service_state, health.sim_state, health.queue_pending, JSON.stringify({ ...(b.details ?? {}), permissions: b.permissions })],
      );
      await db.query(
        `UPDATE gateways SET last_seen_at = now(), last_ip = $3, last_health = $2, offline_alerted_at = NULL,
                app_version = coalesce($4, app_version) WHERE id = $1`,
        [gw.id, JSON.stringify(health), req.ip, b.app_version ?? null],
      );
      if (b.kind && String(b.kind) !== 'HEARTBEAT') {
        await audit(db, { actorType: 'GATEWAY', actorId: gw.id, action: `gateway.${String(b.kind).toLowerCase()}`, entityType: 'gateway', entityId: gw.id, details: b.details ?? {} });
      }
      return gatewayConfig(db, gw.id);
    },
  );

  app.post(
    '/gateway/sim',
    {
      preHandler: authGw,
      config: gwRate,
      schema: {
        tags: ['gateway (phone)'],
        summary: 'Report the SIM selected for sending',
        body: Type.Object({
          subscription_id: Type.Integer(),
          slot_index: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
          display_name: Type.Optional(Type.String({ maxLength: 60 })),
          carrier_name: Type.Optional(Type.String({ maxLength: 60 })),
        }),
      },
    },
    async (req) => {
      const b = req.body;
      await withTx(db, async (tx) => {
        await tx.query(
          `UPDATE gateways SET sim_subscription_id = $2, sim_slot_index = $3, sim_display_name = $4, sim_carrier_name = $5 WHERE id = $1`,
          [req.gateway!.id, b.subscription_id, b.slot_index ?? null, b.display_name ?? null, b.carrier_name ?? null],
        );
        await audit(tx, { actorType: 'GATEWAY', actorId: req.gateway!.id, action: 'gateway.sim_selected', entityType: 'gateway', entityId: req.gateway!.id, details: b });
      });
      return gatewayConfig(db, req.gateway!.id);
    },
  );

  app.post(
    '/gateway/lease',
    {
      preHandler: authGw,
      config: gwRate,
      schema: {
        tags: ['gateway (phone)'],
        summary: 'Receive a batch of messages to send (each must still be confirmed just before sending)',
        body: Type.Object({ max: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 20 })) }),
      },
    },
    async (req) => leaseJobs(db, req.gateway!.id, req.body.max ?? 20),
  );

  app.post(
    '/gateway/attempts/:id/confirm',
    {
      preHandler: authGw,
      config: gwRate,
      schema: {
        tags: ['gateway (phone)'],
        summary: 'Ask permission to send one leased message now. The phone must not send unless the answer is SEND.',
        params: Type.Object({ id: Uuid }),
      },
    },
    async (req) => confirmSend(db, req.gateway!.id, req.params.id),
  );

  app.post(
    '/gateway/events',
    {
      preHandler: authGw,
      config: gwRate,
      schema: {
        tags: ['gateway (phone)'],
        summary: 'Report sent results, delivery reports, opt-out replies and diagnostics (idempotent, batched)',
        body: Type.Object({ events: Type.Array(EventSchema, { minItems: 1, maxItems: 200 }) }),
      },
    },
    async (req) => ({ acks: await applyEvents(db, req.gateway!, req.body.events as GatewayEvent[]) }),
  );

  app.post(
    '/gateway/release',
    {
      preHandler: authGw,
      config: gwRate,
      schema: {
        tags: ['gateway (phone)'],
        summary: 'Give back leased messages the phone will not send (pause, emergency stop, shutdown)',
        body: Type.Object({ attempt_ids: Type.Array(Uuid, { minItems: 1, maxItems: 200 }), reason: Type.String({ maxLength: 100 }) }),
      },
    },
    async (req) => ({ released: await releaseAttempts(db, req.gateway!, req.body.attempt_ids, req.body.reason) }),
  );

  app.get('/gateway/config', { preHandler: authGw, config: gwRate, schema: { tags: ['gateway (phone)'] } }, async (req) =>
    gatewayConfig(db, req.gateway!.id),
  );
};

export default routes;
