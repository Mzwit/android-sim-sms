import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from 'typebox';
import { withTx, type Queryable, type Tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { idempotent } from '../lib/idempotency.js';
import { maskPhone } from '../lib/phone.js';
import { analyzeSms, estimateCost, MAX_SEGMENTS } from '../lib/segments.js';
import { getSetting } from '../lib/settings.js';
import { validateTemplate, TEMPLATE_FIELDS } from '../lib/template.js';
import { can, requirePerm } from '../auth/session.js';
import { evaluateRecipients, loadCandidates, summarize } from '../services/eligibility.js';
import { IdParams, Pagination, Uuid, actor, pageOf } from './common.js';

const TIME = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

const Schedule = Type.Object(
  {
    start_at: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
    timezone: Type.Optional(Type.String({ default: 'Africa/Mbabane' })),
    window_start: Type.Optional(Type.String({ pattern: TIME, default: '08:00' })),
    window_end: Type.Optional(Type.String({ pattern: TIME, default: '18:00' })),
    days_of_week: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, maxItems: 7, uniqueItems: true })),
    cooldown_every: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 100000 }), Type.Null()])),
    cooldown_seconds: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 86400 }), Type.Null()])),
  },
  { additionalProperties: false },
);

const CampaignFields = {
  name: Type.String({ minLength: 1, maxLength: 150 }),
  body_template: Type.String({ minLength: 1, maxLength: 1600 }),
  group_ids: Type.Array(Uuid, { minItems: 1, maxItems: 50, uniqueItems: true }),
  consent_purpose: Type.Optional(Type.String({ minLength: 1, maxLength: 60, default: 'general' })),
  max_recipients: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  budget_segments: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  cost_per_segment: Type.Optional(Type.Number({ minimum: 0, maximum: 1000 })),
  currency: Type.Optional(Type.String({ pattern: '^[A-Z]{3}$' })),
  failure_pause_ratio: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
  failure_window_size: Type.Optional(Type.Integer({ minimum: 5, maximum: 10000 })),
  schedule: Type.Optional(Schedule),
};
const CreateBody = Type.Object(CampaignFields, { additionalProperties: false });
const PatchBody = Type.Partial(Type.Object(CampaignFields, { additionalProperties: false }));
type CreateInput = Static<typeof CreateBody>;

async function validateCampaignInput(q: Queryable, b: Partial<CreateInput>) {
  if (b.body_template !== undefined) {
    const t = validateTemplate(b.body_template);
    if (t.issues.length) {
      throw unprocessable('INVALID_TEMPLATE', `Template problems. Allowed fields: ${TEMPLATE_FIELDS.join(', ')}`, t.issues);
    }
    if (analyzeSms(b.body_template).segments > MAX_SEGMENTS) {
      throw unprocessable('MESSAGE_TOO_LONG', `Message would exceed ${MAX_SEGMENTS} SMS segments`);
    }
  }
  if (b.max_recipients !== undefined) {
    const cap = await getSetting(q, 'max_campaign_recipients');
    if (b.max_recipients > cap) throw unprocessable('OVER_RECIPIENT_CAP', `max_recipients cannot exceed the configured cap of ${cap}`);
  }
  if (b.group_ids) {
    const { rows } = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM contact_groups WHERE id = ANY($1::uuid[])', [b.group_ids]);
    if (rows[0]!.n !== b.group_ids.length) throw badRequest('UNKNOWN_GROUP', 'One or more group_ids do not exist');
  }
  const s = b.schedule;
  if (s) {
    if (s.timezone && !TIMEZONES.has(s.timezone)) throw badRequest('INVALID_TIMEZONE', `Unknown time zone ${s.timezone}`);
    if ((s.window_start ?? '08:00') >= (s.window_end ?? '18:00')) throw badRequest('INVALID_WINDOW', 'window_start must be before window_end');
    if ((s.cooldown_every == null) !== (s.cooldown_seconds == null)) {
      throw badRequest('INVALID_COOLDOWN', 'Set both cooldown_every and cooldown_seconds, or neither');
    }
    if (s.start_at && new Date(s.start_at).getTime() < Date.now() - 60_000) throw badRequest('START_IN_PAST', 'start_at is in the past');
  }
}

async function upsertSchedule(tx: Tx, campaignId: string, s: Static<typeof Schedule> | undefined) {
  const v = s ?? {};
  await tx.query(
    `INSERT INTO campaign_schedules (campaign_id, start_at, timezone, window_start, window_end, days_of_week, cooldown_every, cooldown_seconds)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (campaign_id) DO UPDATE SET start_at = EXCLUDED.start_at, timezone = EXCLUDED.timezone,
       window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end, days_of_week = EXCLUDED.days_of_week,
       cooldown_every = EXCLUDED.cooldown_every, cooldown_seconds = EXCLUDED.cooldown_seconds, updated_at = now()`,
    [
      campaignId,
      v.start_at ?? null,
      v.timezone ?? 'Africa/Mbabane',
      v.window_start ?? '08:00',
      v.window_end ?? '18:00',
      v.days_of_week ?? [1, 2, 3, 4, 5],
      v.cooldown_every ?? null,
      v.cooldown_seconds ?? null,
    ],
  );
}

export async function loadCampaign(q: Queryable, id: string) {
  const { rows } = await q.query(
    `SELECT c.*, to_char(s.window_start, 'HH24:MI') AS window_start, to_char(s.window_end, 'HH24:MI') AS window_end,
            s.start_at, s.timezone, s.days_of_week, s.cooldown_every, s.cooldown_seconds,
            coalesce((SELECT array_agg(cg.group_id) FROM campaign_groups cg WHERE cg.campaign_id = c.id), '{}') AS group_ids,
            (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*)::int n FROM messages m WHERE m.campaign_id = c.id GROUP BY status) x) AS message_counts
       FROM campaigns c LEFT JOIN campaign_schedules s ON s.campaign_id = c.id WHERE c.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return undefined;
  const { window_start, window_end, start_at, timezone, days_of_week, cooldown_every, cooldown_seconds, ...rest } = r;
  return {
    ...rest,
    message_counts: r.message_counts ?? {},
    template_analysis: analyzeSms(r.body_template),
    schedule: { start_at, timezone, window_start, window_end, days_of_week, cooldown_every, cooldown_seconds },
  };
}

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const { db } = app.deps;
  const read = [app.authenticate, requirePerm('campaigns.read')];
  const write = [app.authenticate, requirePerm('campaigns.write')];

  app.post(
    '/campaigns',
    {
      preHandler: write,
      schema: {
        tags: ['campaigns'],
        summary: 'Create a DRAFT campaign. Requires an Idempotency-Key header; retries with the same key return the same campaign.',
        headers: Type.Object({ 'idempotency-key': Type.String({ minLength: 8, maxLength: 128 }) }),
        body: CreateBody,
      },
    },
    async (req, reply) => {
      const b = req.body;
      await validateCampaignInput(db, b);
      return idempotent(db, req, reply, 'POST /campaigns', 201, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO campaigns (name, body_template, consent_purpose, max_recipients, budget_segments, cost_per_segment, currency,
                                  failure_pause_ratio, failure_window_size, created_by)
           VALUES ($1, $2, $3, coalesce($4::int, 10000), $5::int, coalesce($6::numeric, 0), coalesce($7::text, 'SZL'),
                   coalesce($8::numeric, 0.2), coalesce($9::int, 50), $10)
           RETURNING id`,
          [
            b.name.trim(),
            b.body_template,
            b.consent_purpose ?? 'general',
            b.max_recipients ?? null,
            b.budget_segments ?? null,
            b.cost_per_segment ?? null,
            b.currency ?? null,
            b.failure_pause_ratio ?? null,
            b.failure_window_size ?? null,
            req.admin!.id,
          ],
        );
        const id = rows[0]!.id;
        await tx.query('INSERT INTO campaign_groups (campaign_id, group_id) SELECT $1, unnest($2::uuid[])', [id, b.group_ids]);
        await upsertSchedule(tx, id, b.schedule);
        await audit(tx, { ...actor(req), action: 'campaign.created', entityType: 'campaign', entityId: id, details: { name: b.name, groups: b.group_ids.length } });
        return loadCampaign(tx, id);
      });
    },
  );

  app.get(
    '/campaigns',
    {
      preHandler: read,
      schema: {
        tags: ['campaigns'],
        querystring: Type.Object({
          status: Type.Optional(Type.String({ pattern: '^[A-Z_]+$' })),
          ...Pagination,
        }),
      },
    },
    async (req) => {
      const { page, pageSize, offset } = pageOf(req.query);
      const params: unknown[] = [];
      let where = 'TRUE';
      if (req.query.status) {
        params.push(req.query.status);
        where = 'c.status = $1';
      }
      const [{ rows }, count] = await Promise.all([
        db.query(
          `SELECT c.id, c.name, c.status, c.created_at, c.approved_at, c.started_at, c.completed_at, a.display_name AS created_by_name,
                  (SELECT count(*)::int FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.decision = 'INCLUDED') AS recipients
             FROM campaigns c JOIN administrators a ON a.id = c.created_by
            WHERE ${where} ORDER BY c.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
          params,
        ),
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM campaigns c WHERE ${where}`, params),
      ]);
      return { items: rows, page, page_size: pageSize, total: count.rows[0]!.n };
    },
  );

  app.get('/campaigns/:id', { preHandler: read, schema: { tags: ['campaigns'], params: IdParams } }, async (req) => {
    const c = await loadCampaign(db, req.params.id);
    if (!c) throw notFound('Campaign');
    return c;
  });

  app.patch(
    '/campaigns/:id',
    { preHandler: write, schema: { tags: ['campaigns'], summary: 'Edit a DRAFT campaign', params: IdParams, body: PatchBody } },
    async (req) => {
      const b = req.body;
      await validateCampaignInput(db, b);
      return withTx(db, async (tx) => {
        const cur = await tx.query<{ status: string }>('SELECT status FROM campaigns WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!cur.rows[0]) throw notFound('Campaign');
        if (cur.rows[0].status !== 'DRAFT') throw conflict('NOT_DRAFT', `Only DRAFT campaigns can be edited (status is ${cur.rows[0].status})`);
        await tx.query(
          `UPDATE campaigns SET name = coalesce($2, name), body_template = coalesce($3, body_template),
             consent_purpose = coalesce($4, consent_purpose), max_recipients = coalesce($5, max_recipients),
             budget_segments = CASE WHEN $6::boolean THEN $7 ELSE budget_segments END,
             cost_per_segment = coalesce($8, cost_per_segment), currency = coalesce($9, currency),
             failure_pause_ratio = coalesce($10, failure_pause_ratio), failure_window_size = coalesce($11, failure_window_size),
             test_message_id = CASE WHEN $3 IS NOT NULL AND $3 <> body_template THEN NULL ELSE test_message_id END
           WHERE id = $1`,
          [
            req.params.id,
            b.name?.trim() ?? null,
            b.body_template ?? null,
            b.consent_purpose ?? null,
            b.max_recipients ?? null,
            b.budget_segments !== undefined,
            b.budget_segments ?? null,
            b.cost_per_segment ?? null,
            b.currency ?? null,
            b.failure_pause_ratio ?? null,
            b.failure_window_size ?? null,
          ],
        );
        if (b.group_ids) {
          await tx.query('DELETE FROM campaign_groups WHERE campaign_id = $1', [req.params.id]);
          await tx.query('INSERT INTO campaign_groups (campaign_id, group_id) SELECT $1, unnest($2::uuid[])', [req.params.id, b.group_ids]);
        }
        if (b.schedule) await upsertSchedule(tx, req.params.id, b.schedule);
        await audit(tx, { ...actor(req), action: 'campaign.updated', entityType: 'campaign', entityId: req.params.id, details: { fields: Object.keys(b) } });
        return loadCampaign(tx, req.params.id);
      });
    },
  );

  app.delete('/campaigns/:id', { preHandler: write, schema: { tags: ['campaigns'], summary: 'Delete a DRAFT campaign', params: IdParams } }, async (req) =>
    withTx(db, async (tx) => {
      const cur = await tx.query<{ status: string; name: string }>('SELECT status, name FROM campaigns WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!cur.rows[0]) throw notFound('Campaign');
      if (cur.rows[0].status !== 'DRAFT') throw conflict('NOT_DRAFT', 'Only DRAFT campaigns can be deleted; cancel it instead');
      await tx.query('DELETE FROM campaigns WHERE id = $1', [req.params.id]);
      await audit(tx, { ...actor(req), action: 'campaign.deleted', entityType: 'campaign', entityId: req.params.id, details: { name: cur.rows[0].name } });
      return { ok: true };
    }),
  );

  app.post(
    '/campaigns/:id/preview',
    {
      preHandler: read,
      schema: {
        tags: ['campaigns'],
        summary:
          'Dry-run recipient checks (validity, opt-out, consent, duplicate numbers, limit), personalised samples, segment and cost estimate. Nothing is queued.',
        params: IdParams,
        body: Type.Optional(Type.Object({ sample_size: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, default: 5 })) }, { additionalProperties: false })),
      },
    },
    async (req) => {
      const c = await loadCampaign(db, req.params.id);
      if (!c) throw notFound('Campaign');
      const candidates = await loadCandidates(db, c.group_ids as string[], c.consent_purpose as string);
      const evaluated = evaluateRecipients(candidates, c.body_template as string, c.max_recipients as number);
      const summary = summarize(evaluated);
      const full = can(req, 'contacts.read_full');
      const sampleSize = req.body?.sample_size ?? 5;
      const samples = evaluated
        .filter((e) => e.decision === 'INCLUDED')
        .slice(0, sampleSize)
        .map((e) => ({
          contact_id: e.contactId,
          phone: full ? e.phoneE164 : maskPhone(e.phoneE164),
          text: e.renderedBody,
          encoding: e.encoding,
          segments: e.segments,
          missing_fields: e.missingFields,
        }));
      const dailyBudget = await getSetting(db, 'daily_segment_budget');
      const budget = c.budget_segments as number | null;
      const warnings: string[] = [];
      if (summary.included === 0) warnings.push('No eligible recipients.');
      if (budget && summary.segmentsTotal > budget) warnings.push(`Needs ${summary.segmentsTotal} segments but the campaign budget is ${budget}.`);
      if (summary.segmentsTotal > dailyBudget) {
        warnings.push(`Needs ${summary.segmentsTotal} segments; the daily budget of ${dailyBudget} means it will span at least ${Math.ceil(summary.segmentsTotal / dailyBudget)} days.`);
      }
      if (summary.encodings.UCS2 > 0) warnings.push(`${summary.encodings.UCS2} message(s) use Unicode (UCS-2): 70 characters per SMS instead of 160.`);
      if (summary.recipientsWithMissingFields > 0) warnings.push(`${summary.recipientsWithMissingFields} recipient(s) have empty personalisation fields with no fallback.`);
      if (summary.excluded.NO_CONSENT > 0) warnings.push(`${summary.excluded.NO_CONSENT} contact(s) excluded for missing consent.`);
      return {
        summary,
        estimated_cost: { amount: estimateCost(summary.segmentsTotal, c.cost_per_segment as number), currency: c.currency, note: 'Estimate from configured cost per segment; actual airtime charges depend on your carrier.' },
        budget: { campaign_segments: budget, daily_segments: dailyBudget },
        samples,
        warnings,
      };
    },
  );
};

export default routes;
