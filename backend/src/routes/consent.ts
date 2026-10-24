import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { withTx } from '../db.js';
import { audit } from '../lib/audit.js';
import { notFound, unprocessable } from '../lib/errors.js';
import { maskPhone, normalizePhone } from '../lib/phone.js';
import { getSetting } from '../lib/settings.js';
import { can, requirePerm } from '../auth/session.js';
import { suppressNumber } from '../services/suppression.js';
import { IdParams, Pagination, actor, pageOf } from './common.js';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const { db } = app.deps;
  const write = [app.authenticate, requirePerm('consent.write')];

  app.post(
    '/contacts/:id/consent',
    {
      preHandler: write,
      schema: {
        tags: ['consent'],
        summary: 'Record consent being granted or withdrawn for a purpose (append-only history)',
        params: IdParams,
        body: Type.Object(
          {
            status: Type.Union([Type.Literal('GRANTED'), Type.Literal('WITHDRAWN')]),
            purpose: Type.Optional(Type.String({ minLength: 1, maxLength: 60, default: 'general' })),
            source: Type.String({ minLength: 2, maxLength: 200 }),
            evidence: Type.Optional(Type.String({ maxLength: 500 })),
            effective_at: Type.Optional(Type.String({ format: 'date-time' })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const b = req.body;
      const rec = await withTx(db, async (tx) => {
        const c = await tx.query('SELECT 1 FROM contacts WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
        if (!c.rowCount) throw notFound('Contact');
        if (b.effective_at && new Date(b.effective_at).getTime() > Date.now() + 5 * 60_000) {
          throw unprocessable('FUTURE_CONSENT', 'effective_at cannot be in the future');
        }
        const { rows } = await tx.query(
          `INSERT INTO consent_records (contact_id, purpose, status, source, evidence, effective_at, recorded_by)
           VALUES ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7)
           RETURNING id, purpose, status, source, evidence, effective_at, recorded_at`,
          [req.params.id, b.purpose ?? 'general', b.status, b.source, b.evidence ?? null, b.effective_at ?? null, req.admin!.id],
        );
        let cancelled = 0;
        if (b.status === 'WITHDRAWN') {
          // Withdrawal takes effect immediately for unsent messages that relied on this consent.
          const purpose = b.purpose ?? 'general';
          const r = await tx.query(
            `UPDATE messages m SET status = 'CANCELLED', last_error_category = 'SUPPRESSED', last_error_code = 'CONSENT_WITHDRAWN', finalized_at = now()
               FROM campaigns c WHERE c.id = m.campaign_id AND m.contact_id = $1 AND m.status = 'QUEUED'
                AND ($2 = 'general' OR c.consent_purpose = $2)`,
            [req.params.id, purpose],
          );
          cancelled = r.rowCount ?? 0;
        }
        rows[0].cancelled_messages = cancelled;
        await audit(tx, { ...actor(req), action: `consent.${b.status.toLowerCase()}`, entityType: 'contact', entityId: req.params.id, details: { purpose: rows[0].purpose, source: b.source } });
        return rows[0];
      });
      reply.code(201);
      return rec;
    },
  );

  app.post(
    '/opt-outs',
    {
      preHandler: write,
      schema: {
        tags: ['consent'],
        summary: 'Opt a phone number out immediately. Cancels its queued messages and records consent withdrawal.',
        body: Type.Object(
          {
            phone: Type.String({ minLength: 1, maxLength: 40 }),
            source: Type.String({ minLength: 2, maxLength: 200, description: 'e.g. "Phoned reception", "Replied STOP"' }),
            note: Type.Optional(Type.String({ maxLength: 500 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      // Opt-outs accept any well-formed number (including fixed lines) so a request is never refused on type.
      const norm = normalizePhone(req.body.phone, await getSetting(db, 'default_country'), { allowNonMobile: true });
      if (!norm.ok) throw unprocessable('INVALID_PHONE', norm.message, { reason: norm.error });
      const r = await withTx(db, (tx) => suppressNumber(tx, norm.e164, 'OPT_OUT', req.body.source, req.body.note ?? null, actor(req)));
      reply.code(r.alreadySuppressed ? 200 : 201);
      return {
        suppression_id: r.suppressionId,
        phone_e164: can(req, 'contacts.read_full') ? norm.e164 : maskPhone(norm.e164),
        already_suppressed: r.alreadySuppressed,
        cancelled_messages: r.cancelledMessages,
      };
    },
  );

  app.get(
    '/suppressions',
    {
      preHandler: [app.authenticate, requirePerm('contacts.read')],
      schema: {
        tags: ['consent'],
        querystring: Type.Object({ active: Type.Optional(Type.Boolean({ default: true })), ...Pagination }),
      },
    },
    async (req) => {
      const { page, pageSize, offset } = pageOf(req.query);
      const active = req.query.active ?? true;
      const cond = active ? 'lifted_at IS NULL' : 'lifted_at IS NOT NULL';
      const [{ rows }, count] = await Promise.all([
        db.query(
          `SELECT id, phone_e164, reason, source, note, created_at, lifted_at, lift_note FROM suppressions
            WHERE ${cond} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
          [pageSize, offset],
        ),
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM suppressions WHERE ${cond}`),
      ]);
      const full = can(req, 'contacts.read_full');
      return {
        items: rows.map((r) => ({ ...r, phone_e164: full ? r.phone_e164 : maskPhone(r.phone_e164) })),
        page,
        page_size: pageSize,
        total: count.rows[0]!.n,
      };
    },
  );

  app.post(
    '/suppressions',
    {
      preHandler: write,
      schema: {
        tags: ['consent'],
        summary: 'Administrative suppression (complaint, wrong number, carrier block)',
        body: Type.Object(
          {
            phone: Type.String({ minLength: 1, maxLength: 40 }),
            reason: Type.Union([Type.Literal('ADMIN'), Type.Literal('COMPLAINT'), Type.Literal('INVALID_NUMBER'), Type.Literal('CARRIER_BLOCK')]),
            source: Type.String({ minLength: 2, maxLength: 200 }),
            note: Type.Optional(Type.String({ maxLength: 500 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const norm = normalizePhone(req.body.phone, await getSetting(db, 'default_country'), { allowNonMobile: true });
      if (!norm.ok) throw unprocessable('INVALID_PHONE', norm.message, { reason: norm.error });
      const r = await withTx(db, (tx) => suppressNumber(tx, norm.e164, req.body.reason, req.body.source, req.body.note ?? null, actor(req)));
      reply.code(r.alreadySuppressed ? 200 : 201);
      return { suppression_id: r.suppressionId, already_suppressed: r.alreadySuppressed, cancelled_messages: r.cancelledMessages };
    },
  );

  app.post(
    '/suppressions/:id/lift',
    {
      preHandler: write,
      schema: {
        tags: ['consent'],
        summary: 'Lift a suppression. For opt-outs, record the evidence of renewed consent in the note.',
        params: IdParams,
        body: Type.Object({ note: Type.String({ minLength: 10, maxLength: 500 }) }, { additionalProperties: false }),
      },
    },
    async (req) =>
      withTx(db, async (tx) => {
        const { rows } = await tx.query(
          `UPDATE suppressions SET lifted_at = now(), lifted_by = $2, lift_note = $3
            WHERE id = $1 AND lifted_at IS NULL RETURNING id, reason`,
          [req.params.id, req.admin!.id, req.body.note],
        );
        if (!rows[0]) throw notFound('Active suppression');
        await audit(tx, { ...actor(req), action: 'suppression.lifted', entityType: 'suppression', entityId: req.params.id, details: { reason: rows[0].reason, note: req.body.note } });
        return { ok: true, note: rows[0].reason === 'OPT_OUT' ? 'Consent is still WITHDRAWN; record new consent on the contact before messaging.' : undefined };
      }),
  );
};

export default routes;
