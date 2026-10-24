import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { withTx } from '../db.js';
import { notFound } from '../lib/errors.js';
import { maskPhone, normalizePhone } from '../lib/phone.js';
import { getSetting } from '../lib/settings.js';
import { can, requirePerm } from '../auth/session.js';
import * as life from '../services/campaign-lifecycle.js';
import { IdParams, Pagination, Uuid, actor, pageOf } from './common.js';

const STATUSES = ['QUEUED', 'LEASED', 'SENDING', 'SUBMITTED', 'DELIVERED', 'FAILED', 'UNKNOWN', 'CANCELLED'] as const;

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const { db } = app.deps;
  const read = [app.authenticate, requirePerm('campaigns.read')];
  const retry = [app.authenticate, requirePerm('messages.retry')];

  app.get(
    '/messages',
    {
      preHandler: read,
      schema: {
        tags: ['messages'],
        summary: 'Per-recipient message tracking. Use status=UNKNOWN for the reconciliation queue, dead_letter=true for exhausted retries.',
        querystring: Type.Object({
          campaign_id: Type.Optional(Uuid),
          status: Type.Optional(Type.Union(STATUSES.map((s) => Type.Literal(s)))),
          delivery_state: Type.Optional(Type.String({ pattern: '^[A-Z_]+$' })),
          dead_letter: Type.Optional(Type.Boolean()),
          is_test: Type.Optional(Type.Boolean()),
          phone: Type.Optional(Type.String({ maxLength: 40, description: 'Full number or at least 4 trailing digits' })),
          contact_id: Type.Optional(Uuid),
          ...Pagination,
        }),
      },
    },
    async (req) => {
      const f = req.query;
      const { page, pageSize, offset } = pageOf(f);
      const where: string[] = [];
      const params: unknown[] = [];
      const p = (v: unknown) => (params.push(v), `$${params.length}`);
      if (f.campaign_id) where.push(`m.campaign_id = ${p(f.campaign_id)}`);
      if (f.status) where.push(`m.status = ${p(f.status)}`);
      if (f.delivery_state) where.push(`m.delivery_state = ${p(f.delivery_state)}`);
      if (f.dead_letter) where.push('m.dead_lettered_at IS NOT NULL');
      if (f.is_test !== undefined) where.push(`m.is_test = ${p(f.is_test)}`);
      if (f.contact_id) where.push(`m.contact_id = ${p(f.contact_id)}`);
      if (f.phone) {
        const n = normalizePhone(f.phone, await getSetting(db, 'default_country'), { allowNonMobile: true });
        const digits = f.phone.replace(/\D/g, '');
        if (n.ok) where.push(`m.phone_e164 = ${p(n.e164)}`);
        else if (digits.length >= 4) where.push(`m.phone_e164 LIKE ${p('%' + digits)}`);
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const countParams = [...params];
      const { rows } = await db.query(
        `SELECT m.id, m.campaign_id, c.name AS campaign_name, m.is_test, m.phone_e164, m.status, m.delivery_state, m.segment_count,
                m.attempt_count, m.max_attempts, m.queued_at, m.submitted_at, m.delivered_at, m.next_attempt_at,
                m.last_error_code, m.last_error_category, m.dead_lettered_at, m.updated_at,
                ct.first_name, ct.last_name,
                EXISTS (SELECT 1 FROM suppressions s WHERE s.phone_e164 = m.phone_e164 AND s.lifted_at IS NULL) AS opted_out
           FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id LEFT JOIN contacts ct ON ct.id = m.contact_id
           ${w} ORDER BY m.updated_at DESC, m.id LIMIT ${p(pageSize)} OFFSET ${p(offset)}`,
        params,
      );
      const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages m ${w}`, countParams);
      const full = can(req, 'contacts.read_full');
      return {
        items: rows.map((r) => ({ ...r, phone_e164: full ? r.phone_e164 : maskPhone(r.phone_e164) })),
        page,
        page_size: pageSize,
        total: count.rows[0]!.n,
      };
    },
  );

  app.get('/messages/:id', { preHandler: read, schema: { tags: ['messages'], summary: 'Full history: attempts, part results, delivery reports, retries, reconciliations', params: IdParams } }, async (req) => {
    const { rows } = await db.query(
      `SELECT m.*, c.name AS campaign_name, ct.first_name, ct.last_name,
              EXISTS (SELECT 1 FROM suppressions s WHERE s.phone_e164 = m.phone_e164 AND s.lifted_at IS NULL) AS opted_out
         FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id LEFT JOIN contacts ct ON ct.id = m.contact_id WHERE m.id = $1`,
      [req.params.id],
    );
    const m = rows[0];
    if (!m) throw notFound('Message');
    const [attempts, parts, reports, retries, recon] = await Promise.all([
      db.query(
        `SELECT a.id, a.attempt_no, a.outcome, a.started_at, a.confirmed_at, a.reported_at, a.device_sent_at, a.parts_total, a.parts_ok,
                a.parts_failed, a.error_code, a.error_category, a.detail, g.name AS gateway_name
           FROM sms_submission_attempts a JOIN gateways g ON g.id = a.gateway_id WHERE a.message_id = $1 ORDER BY a.attempt_no`,
        [req.params.id],
      ),
      db.query(`SELECT p.attempt_id, p.part_index, p.result_code, p.ok, p.reported_at FROM sms_part_results p
                  JOIN sms_submission_attempts a ON a.id = p.attempt_id WHERE a.message_id = $1 ORDER BY p.reported_at`, [req.params.id]),
      db.query(`SELECT attempt_id, part_index, status, tp_status, received_at FROM delivery_reports WHERE message_id = $1 ORDER BY received_at`, [req.params.id]),
      db.query(`SELECT r.kind, r.reason, r.scheduled_for, r.created_at, a.display_name AS requested_by FROM retry_jobs r
                  LEFT JOIN administrators a ON a.id = r.requested_by WHERE r.message_id = $1 ORDER BY r.created_at`, [req.params.id]),
      db.query(`SELECT r.decision, r.note, r.decided_at, a.display_name AS decided_by FROM reconciliations r
                  JOIN administrators a ON a.id = r.decided_by WHERE r.message_id = $1 ORDER BY r.decided_at`, [req.params.id]),
    ]);
    const full = can(req, 'contacts.read_full');
    return {
      ...m,
      phone_e164: full ? m.phone_e164 : maskPhone(m.phone_e164),
      lease_id: undefined,
      attempts: attempts.rows,
      part_results: parts.rows,
      delivery_reports: reports.rows,
      retries: retries.rows,
      reconciliations: recon.rows,
    };
  });

  app.post(
    '/messages/:id/retry',
    {
      preHandler: retry,
      schema: {
        tags: ['messages'],
        summary: 'One more attempt for a FAILED message (never for opted-out recipients; invalid numbers need force)',
        params: IdParams,
        body: Type.Object({ note: Type.String({ minLength: 3, maxLength: 300 }), force: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      },
    },
    async (req) => {
      await withTx(db, (tx) => life.manualRetry(tx, req.params.id, req.body.note, req.body.force ?? false, actor(req)));
      return { ok: true };
    },
  );

  app.post(
    '/messages/:id/reconcile',
    {
      preHandler: retry,
      schema: {
        tags: ['messages'],
        summary: 'Resolve an UNKNOWN message before any resend',
        params: IdParams,
        body: Type.Object(
          {
            decision: Type.Union([Type.Literal('CONFIRMED_SENT'), Type.Literal('CONFIRMED_NOT_SENT'), Type.Literal('RESEND'), Type.Literal('ABANDON')]),
            note: Type.String({ minLength: 5, maxLength: 500, description: 'How you established this, e.g. "Checked Sent folder on the phone"' }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      await withTx(db, (tx) => life.reconcile(tx, req.params.id, req.body.decision, req.body.note, actor(req)));
      return { ok: true };
    },
  );
};

export default routes;
