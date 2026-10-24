import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { withTx, type Queryable } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { maskPhone, normalizePhone } from '../lib/phone.js';
import { getSetting } from '../lib/settings.js';
import { can, requirePerm } from '../auth/session.js';
import { IdParams, Pagination, Uuid, actor, likeEscape, pageOf } from './common.js';

const Tag = Type.String({ minLength: 1, maxLength: 40, pattern: '^[A-Za-z0-9_\\- ]+$' });
const ConsentInput = Type.Object(
  {
    purpose: Type.Optional(Type.String({ minLength: 1, maxLength: 60, default: 'general' })),
    source: Type.String({ minLength: 2, maxLength: 200 }),
    evidence: Type.Optional(Type.String({ maxLength: 500 })),
    effective_at: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false },
);

const ContactBody = {
  first_name: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
  last_name: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
  reference_no: Type.Optional(Type.Union([Type.String({ maxLength: 60 }), Type.Null()])),
  email: Type.Optional(Type.Union([Type.String({ format: 'email', maxLength: 254 }), Type.Null()])),
  tags: Type.Optional(Type.Array(Tag, { maxItems: 30, uniqueItems: true })),
  attributes: Type.Optional(Type.Record(Type.String({ maxLength: 40 }), Type.Union([Type.String({ maxLength: 200 }), Type.Number(), Type.Boolean(), Type.Null()]))),
};

export const CONTACT_SELECT = `
SELECT c.id, c.phone_e164, c.phone_raw, c.is_valid, c.validation_error, c.first_name, c.last_name,
       c.reference_no, c.email, c.tags, c.attributes, c.created_at, c.updated_at,
       (SELECT cr.status FROM consent_records cr WHERE cr.contact_id = c.id AND cr.purpose = 'general'
         ORDER BY cr.effective_at DESC, cr.recorded_at DESC LIMIT 1) AS consent_general,
       EXISTS (SELECT 1 FROM suppressions s WHERE s.phone_e164 = c.phone_e164 AND s.lifted_at IS NULL) AS opted_out,
       coalesce((SELECT array_agg(gm.group_id) FROM group_memberships gm WHERE gm.contact_id = c.id), '{}') AS group_ids
  FROM contacts c`;

interface ContactRow {
  id: string;
  phone_e164: string | null;
  phone_raw: string;
  [k: string]: unknown;
}

/** Apply the caller's data-access level: full numbers need contacts.read_full. */
export function present(req: FastifyRequest, row: ContactRow) {
  const full = can(req, 'contacts.read_full');
  const { phone_raw, ...rest } = row;
  return {
    ...rest,
    phone_e164: full ? row.phone_e164 : maskPhone(row.phone_e164),
    phone_raw: full ? phone_raw : undefined,
    phone_masked: !full,
  };
}

async function loadContact(q: Queryable, id: string): Promise<ContactRow | undefined> {
  const { rows } = await q.query<ContactRow>(`${CONTACT_SELECT} WHERE c.id = $1 AND c.deleted_at IS NULL`, [id]);
  return rows[0];
}

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const { db } = app.deps;
  const read = [app.authenticate, requirePerm('contacts.read')];
  const write = [app.authenticate, requirePerm('contacts.write')];

  app.get(
    '/contacts',
    {
      preHandler: read,
      schema: {
        tags: ['contacts'],
        summary: 'Search and filter contacts (paginated)',
        querystring: Type.Object({
          q: Type.Optional(Type.String({ maxLength: 100, description: 'Name, reference number, email, or trailing phone digits' })),
          group_id: Type.Optional(Uuid),
          tag: Type.Optional(Tag),
          valid: Type.Optional(Type.Boolean()),
          opted_out: Type.Optional(Type.Boolean()),
          consent: Type.Optional(Type.Union([Type.Literal('GRANTED'), Type.Literal('WITHDRAWN'), Type.Literal('NONE')])),
          sort: Type.Optional(Type.Union([Type.Literal('name'), Type.Literal('created_at'), Type.Literal('-created_at')], { default: 'name' })),
          ...Pagination,
        }),
      },
    },
    async (req) => {
      const f = req.query;
      const { page, pageSize, offset } = pageOf(f);
      const where: string[] = ['c.deleted_at IS NULL'];
      const params: unknown[] = [];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      if (f.q?.trim()) {
        const term = f.q.trim();
        const digits = term.replace(/\D/g, '');
        const like = p(`%${likeEscape(term)}%`);
        const ors = [
          `c.first_name ILIKE ${like}`,
          `c.last_name ILIKE ${like}`,
          `(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) ILIKE ${like}`,
          `c.reference_no ILIKE ${like}`,
          `c.email::text ILIKE ${like}`,
        ];
        if (digits.length >= 4) ors.push(`c.phone_e164 LIKE ${p(`%${digits}`)}`);
        where.push(`(${ors.join(' OR ')})`);
      }
      if (f.group_id) where.push(`EXISTS (SELECT 1 FROM group_memberships gm WHERE gm.contact_id = c.id AND gm.group_id = ${p(f.group_id)})`);
      if (f.tag) where.push(`${p(f.tag)} = ANY(c.tags)`);
      if (f.valid !== undefined) where.push(`c.is_valid = ${p(f.valid)}`);
      if (f.opted_out !== undefined) {
        where.push(`${f.opted_out ? '' : 'NOT '}EXISTS (SELECT 1 FROM suppressions s WHERE s.phone_e164 = c.phone_e164 AND s.lifted_at IS NULL)`);
      }
      if (f.consent) {
        const latest = `(SELECT cr.status FROM consent_records cr WHERE cr.contact_id = c.id AND cr.purpose = 'general' ORDER BY cr.effective_at DESC, cr.recorded_at DESC LIMIT 1)`;
        where.push(f.consent === 'NONE' ? `${latest} IS NULL` : `${latest} = ${p(f.consent)}`);
      }
      const order =
        f.sort === 'created_at' ? 'c.created_at, c.id' : f.sort === '-created_at' ? 'c.created_at DESC, c.id' : 'lower(c.last_name) NULLS LAST, lower(c.first_name) NULLS LAST, c.id';
      const whereSql = where.join(' AND ');
      const [{ rows }, count] = await Promise.all([
        db.query<ContactRow>(`${CONTACT_SELECT} WHERE ${whereSql} ORDER BY ${order} LIMIT ${p(pageSize)} OFFSET ${p(offset)}`, params),
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM contacts c WHERE ${whereSql}`, params.slice(0, params.length - 2)),
      ]);
      return { items: rows.map((r) => present(req, r)), page, page_size: pageSize, total: count.rows[0]!.n };
    },
  );

  app.get('/contacts/:id', { preHandler: read, schema: { tags: ['contacts'], params: IdParams } }, async (req) => {
    const row = await loadContact(db, req.params.id);
    if (!row) throw notFound('Contact');
    const consent = await db.query(
      `SELECT id, purpose, status, source, evidence, effective_at, recorded_at FROM consent_records
        WHERE contact_id = $1 ORDER BY effective_at DESC, recorded_at DESC LIMIT 100`,
      [req.params.id],
    );
    return { ...present(req, row), consent_history: consent.rows };
  });

  app.post(
    '/contacts',
    {
      preHandler: write,
      schema: {
        tags: ['contacts'],
        summary: 'Create one contact. Invalid or duplicate numbers are rejected with details (never silently changed).',
        body: Type.Object(
          {
            phone: Type.String({ minLength: 1, maxLength: 40 }),
            country: Type.Optional(Type.String({ pattern: '^[A-Z]{2}$' })),
            ...ContactBody,
            group_ids: Type.Optional(Type.Array(Uuid, { maxItems: 50, uniqueItems: true })),
            consent: Type.Optional(ConsentInput),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const b = req.body;
      const country = b.country ?? (await getSetting(db, 'default_country'));
      const norm = normalizePhone(b.phone, country);
      if (!norm.ok) throw unprocessable('INVALID_PHONE', norm.message, { reason: norm.error, input: b.phone });
      const id = await withTx(db, async (tx) => {
        const dup = await tx.query<{ id: string }>('SELECT id FROM contacts WHERE phone_e164 = $1 AND deleted_at IS NULL', [norm.e164]);
        if (dup.rows[0]) throw conflict('DUPLICATE_PHONE', 'A contact with this phone number already exists', { existing_contact_id: dup.rows[0].id });
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO contacts (phone_e164, phone_raw, is_valid, first_name, last_name, reference_no, email, tags, attributes, created_by)
           VALUES ($1, $2, true, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [
            norm.e164,
            b.phone,
            b.first_name?.trim() || null,
            b.last_name?.trim() || null,
            b.reference_no?.trim() || null,
            b.email || null,
            b.tags ?? [],
            JSON.stringify(b.attributes ?? {}),
            req.admin!.id,
          ],
        );
        const cid = rows[0]!.id;
        if (b.group_ids?.length) {
          const ins = await tx.query(
            `INSERT INTO group_memberships (group_id, contact_id, added_by)
             SELECT g.id, $1, $2 FROM contact_groups g WHERE g.id = ANY($3::uuid[])`,
            [cid, req.admin!.id, b.group_ids],
          );
          if (ins.rowCount !== b.group_ids.length) throw badRequest('UNKNOWN_GROUP', 'One or more group_ids do not exist');
        }
        if (b.consent) {
          await tx.query(
            `INSERT INTO consent_records (contact_id, purpose, status, source, evidence, effective_at, recorded_by)
             VALUES ($1, $2, 'GRANTED', $3, $4, coalesce($5::timestamptz, now()), $6)`,
            [cid, b.consent.purpose ?? 'general', b.consent.source, b.consent.evidence ?? null, b.consent.effective_at ?? null, req.admin!.id],
          );
        }
        await audit(tx, { ...actor(req), action: 'contact.created', entityType: 'contact', entityId: cid, details: { consent: Boolean(b.consent) } });
        return cid;
      });
      reply.code(201);
      return present(req, (await loadContact(db, id))!);
    },
  );

  app.patch(
    '/contacts/:id',
    {
      preHandler: write,
      schema: {
        tags: ['contacts'],
        summary: 'Edit a contact. Changing the phone re-validates it.',
        params: IdParams,
        body: Type.Object(
          { phone: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })), country: Type.Optional(Type.String({ pattern: '^[A-Z]{2}$' })), ...ContactBody },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const b = req.body;
      await withTx(db, async (tx) => {
        const cur = await tx.query<{ phone_e164: string | null }>('SELECT phone_e164 FROM contacts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [req.params.id]);
        if (!cur.rows[0]) throw notFound('Contact');
        let phone: { e164: string; raw: string } | undefined;
        if (b.phone !== undefined) {
          const norm = normalizePhone(b.phone, b.country ?? (await getSetting(tx, 'default_country')));
          if (!norm.ok) throw unprocessable('INVALID_PHONE', norm.message, { reason: norm.error, input: b.phone });
          if (norm.e164 !== cur.rows[0].phone_e164) {
            const dup = await tx.query<{ id: string }>('SELECT id FROM contacts WHERE phone_e164 = $1 AND deleted_at IS NULL AND id <> $2', [norm.e164, req.params.id]);
            if (dup.rows[0]) throw conflict('DUPLICATE_PHONE', 'Another contact already has this phone number', { existing_contact_id: dup.rows[0].id });
          }
          phone = { e164: norm.e164, raw: b.phone };
        }
        const sets: string[] = [];
        const params: unknown[] = [req.params.id];
        const set = (col: string, v: unknown) => {
          params.push(v);
          sets.push(`${col} = $${params.length}`);
        };
        if (phone) {
          set('phone_e164', phone.e164);
          set('phone_raw', phone.raw);
          sets.push('is_valid = true', 'validation_error = NULL');
        }
        for (const k of ['first_name', 'last_name', 'reference_no'] as const) if (b[k] !== undefined) set(k, b[k]?.trim() || null);
        if (b.email !== undefined) set('email', b.email || null);
        if (b.tags !== undefined) set('tags', b.tags);
        if (b.attributes !== undefined) set('attributes', JSON.stringify(b.attributes));
        if (!sets.length) throw badRequest('NOTHING_TO_UPDATE', 'No fields supplied');
        await tx.query(`UPDATE contacts SET ${sets.join(', ')} WHERE id = $1`, params);
        await audit(tx, {
          ...actor(req),
          action: 'contact.updated',
          entityType: 'contact',
          entityId: req.params.id,
          details: { fields: Object.keys(b), phone_changed: Boolean(phone && phone.e164 !== cur.rows[0].phone_e164) },
        });
      });
      return present(req, (await loadContact(db, req.params.id))!);
    },
  );

  app.delete(
    '/contacts/:id',
    { preHandler: [app.authenticate, requirePerm('contacts.delete')], schema: { tags: ['contacts'], summary: 'Soft-delete a contact; suppression records for the number are kept', params: IdParams } },
    async (req) => {
      await withTx(db, async (tx) => {
        const r = await tx.query('UPDATE contacts SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
        if (!r.rowCount) throw notFound('Contact');
        await tx.query('DELETE FROM group_memberships WHERE contact_id = $1', [req.params.id]);
        await audit(tx, { ...actor(req), action: 'contact.deleted', entityType: 'contact', entityId: req.params.id });
      });
      return { ok: true };
    },
  );

  app.post(
    '/contacts/bulk-update',
    {
      preHandler: write,
      schema: {
        tags: ['contacts'],
        summary: 'Add/remove tags and group memberships for many contacts at once',
        body: Type.Object(
          {
            contact_ids: Type.Array(Uuid, { minItems: 1, maxItems: 10000, uniqueItems: true }),
            add_tags: Type.Optional(Type.Array(Tag, { maxItems: 20 })),
            remove_tags: Type.Optional(Type.Array(Tag, { maxItems: 20 })),
            add_group_ids: Type.Optional(Type.Array(Uuid, { maxItems: 20 })),
            remove_group_ids: Type.Optional(Type.Array(Uuid, { maxItems: 20 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const b = req.body;
      return withTx(db, async (tx) => {
        const found = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [b.contact_ids]);
        if (found.rows[0]!.n !== b.contact_ids.length) throw badRequest('UNKNOWN_CONTACT', 'One or more contact_ids do not exist or are deleted');
        let tagged = 0;
        if (b.add_tags?.length || b.remove_tags?.length) {
          const r = await tx.query(
            `UPDATE contacts SET tags = ARRAY(
               SELECT DISTINCT t FROM unnest(tags || $2::text[]) t WHERE NOT (t = ANY($3::text[])) ORDER BY t)
             WHERE id = ANY($1::uuid[])`,
            [b.contact_ids, b.add_tags ?? [], b.remove_tags ?? []],
          );
          tagged = r.rowCount ?? 0;
        }
        let added = 0;
        let removed = 0;
        if (b.add_group_ids?.length) {
          const g = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM contact_groups WHERE id = ANY($1::uuid[])', [b.add_group_ids]);
          if (g.rows[0]!.n !== new Set(b.add_group_ids).size) throw badRequest('UNKNOWN_GROUP', 'One or more add_group_ids do not exist');
          const r = await tx.query(
            `INSERT INTO group_memberships (group_id, contact_id, added_by)
             SELECT g, c, $3 FROM unnest($1::uuid[]) g CROSS JOIN unnest($2::uuid[]) c ON CONFLICT DO NOTHING`,
            [b.add_group_ids, b.contact_ids, req.admin!.id],
          );
          added = r.rowCount ?? 0;
        }
        if (b.remove_group_ids?.length) {
          const r = await tx.query('DELETE FROM group_memberships WHERE group_id = ANY($1::uuid[]) AND contact_id = ANY($2::uuid[])', [b.remove_group_ids, b.contact_ids]);
          removed = r.rowCount ?? 0;
        }
        const summary = { contacts: b.contact_ids.length, tagged, memberships_added: added, memberships_removed: removed };
        await audit(tx, { ...actor(req), action: 'contact.bulk_updated', entityType: 'contact', details: { ...summary, add_tags: b.add_tags, remove_tags: b.remove_tags, add_group_ids: b.add_group_ids, remove_group_ids: b.remove_group_ids } });
        return summary;
      });
    },
  );
};

export default routes;
