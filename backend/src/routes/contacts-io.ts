import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { Readable } from 'node:stream';
import { withTx } from '../db.js';
import { audit } from '../lib/audit.js';
import { CSV_BOM, csvRow } from '../lib/csv.js';
import { badRequest, notFound } from '../lib/errors.js';
import { isValidCountry, maskPhone } from '../lib/phone.js';
import { getSetting } from '../lib/settings.js';
import { can, requirePerm } from '../auth/session.js';
import { commitImport, importProblems, stageImport } from '../services/importer.js';
import { IdParams, Uuid, actor } from './common.js';

export const CSV_TEMPLATE =
  CSV_BOM +
  csvRow(['phone', 'first_name', 'last_name', 'reference_no', 'email', 'tags', 'consent_source', 'consent_date']) +
  csvRow(['7612 3456', 'Thandeka', 'Dlamini', 'STU-2026-0001', 'thandeka@example.org', 'student;year3', 'Registration form 2026', '2026-02-01']) +
  csvRow(['+268 7898 7654', 'Sibusiso', 'Nkambule', 'STU-2026-0002', '', 'student', 'Registration form 2026', '2026-02-03']);

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const { db } = app.deps;
  const write = [app.authenticate, requirePerm('contacts.write')];

  app.get('/contacts/import/template.csv', { preHandler: [app.authenticate], schema: { tags: ['contacts'], summary: 'Sample CSV import template' } }, async (_req, reply) => {
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="contacts-template.csv"');
    return CSV_TEMPLATE;
  });

  app.post(
    '/contacts/import',
    {
      preHandler: write,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['contacts'],
        summary: 'Step 1: upload a CSV or XLSX (multipart field "file", optional field "country"). Rows are validated and staged; nothing is saved to contacts yet.',
        consumes: ['multipart/form-data'],
      },
    },
    async (req, reply) => {
      if (!req.isMultipart()) throw badRequest('MULTIPART_REQUIRED', 'Send multipart/form-data with a "file" field');
      let country = await getSetting(db, 'default_country');
      let result: Awaited<ReturnType<typeof stageImport>> | undefined;
      for await (const part of req.parts()) {
        if (part.type === 'field' && part.fieldname === 'country') {
          const c = String(part.value).trim().toUpperCase();
          if (!isValidCountry(c)) throw badRequest('INVALID_COUNTRY', `Unknown country code ${c}`);
          country = c;
        } else if (part.type === 'file' && part.fieldname === 'file') {
          if (result) throw badRequest('ONE_FILE_ONLY', 'Upload one file at a time');
          result = await stageImport(db, { stream: part.file, filename: part.filename }, country, req.admin!.id, req.ip);
          if (part.file.truncated) throw badRequest('FILE_TOO_LARGE', 'File exceeds 10 MB');
        } else if (part.type === 'file') {
          part.file.resume();
        }
      }
      if (!result) throw badRequest('NO_FILE', 'No "file" field in the upload');
      reply.code(201);
      return result;
    },
  );

  app.get(
    '/contacts/imports/:id',
    {
      preHandler: [app.authenticate, requirePerm('contacts.read')],
      schema: { tags: ['contacts'], params: IdParams, querystring: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })) }) },
    },
    async (req) => {
      const { rows } = await db.query('SELECT id, filename, file_type, country, status, summary, result, created_at, committed_at FROM contact_imports WHERE id = $1', [req.params.id]);
      if (!rows[0]) throw notFound('Import');
      return { ...rows[0], problems: await importProblems(db, req.params.id, 200, req.query.offset ?? 0) };
    },
  );

  app.get('/contacts/imports/:id/problems.csv', { preHandler: [app.authenticate, requirePerm('contacts.read')], schema: { tags: ['contacts'], params: IdParams } }, async (req, reply) => {
    const rows = await importProblems(db, req.params.id, 50_000, 0);
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="import-problems.csv"');
    return CSV_BOM + csvRow(['row', 'phone_as_entered', 'first_name', 'last_name', 'problem', 'detail', 'duplicate_of_row']) +
      rows.map((r) => csvRow([r.row_no + 1, r.phone_raw, r.first_name, r.last_name, r.error_code ?? 'DUPLICATE_IN_FILE', r.error_message ?? `Same number as row ${r.duplicate_of_row + 1}`, r.duplicate_of_row ? r.duplicate_of_row + 1 : ''])).join('');
  });

  app.post(
    '/contacts/imports/:id/commit',
    {
      preHandler: write,
      schema: {
        tags: ['contacts'],
        summary: 'Step 2: create contacts from the staged rows',
        params: IdParams,
        body: Type.Object(
          {
            on_existing: Type.Union([Type.Literal('skip'), Type.Literal('update')], { default: 'skip' }),
            group_ids: Type.Optional(Type.Array(Uuid, { maxItems: 20, uniqueItems: true })),
            add_tags: Type.Optional(Type.Array(Type.String({ pattern: '^[A-Za-z0-9_\\- ]{1,40}$' }), { maxItems: 10 })),
            store_invalid: Type.Optional(Type.Boolean({ default: false })),
            default_consent: Type.Optional(
              Type.Union([
                Type.Object({
                  source: Type.String({ minLength: 2, maxLength: 200 }),
                  evidence: Type.Optional(Type.String({ maxLength: 500 })),
                  effective_at: Type.Optional(Type.String({ format: 'date-time' })),
                }),
                Type.Null(),
              ]),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) =>
      commitImport(
        db,
        req.params.id,
        {
          on_existing: req.body.on_existing ?? 'skip',
          group_ids: req.body.group_ids ?? [],
          add_tags: req.body.add_tags ?? [],
          store_invalid: req.body.store_invalid ?? false,
          default_consent: req.body.default_consent ?? null,
        },
        { actorId: req.admin!.id, ip: req.ip },
      ),
  );

  app.post('/contacts/imports/:id/discard', { preHandler: write, schema: { tags: ['contacts'], params: IdParams } }, async (req) => {
    const r = await db.query(`UPDATE contact_imports SET status = 'DISCARDED' WHERE id = $1 AND status = 'STAGED'`, [req.params.id]);
    if (!r.rowCount) throw notFound('Staged import');
    await db.query('DELETE FROM contact_import_rows WHERE import_id = $1', [req.params.id]);
    return { ok: true };
  });

  app.get(
    '/contacts/export.csv',
    {
      preHandler: [app.authenticate, requirePerm('contacts.export')],
      schema: {
        tags: ['contacts'],
        summary: 'Export contacts (streamed). Full numbers need contacts.read_full; every export is audited.',
        querystring: Type.Object({ group_id: Type.Optional(Uuid), include_invalid: Type.Optional(Type.Boolean({ default: true })) }),
      },
    },
    async (req, reply) => {
      const full = can(req, 'contacts.read_full');
      await audit(db, { ...actor(req), action: 'contacts.exported', entityType: 'contact', details: { group_id: req.query.group_id ?? null, full_numbers: full } });
      const groupId = req.query.group_id ?? null;
      const includeInvalid = req.query.include_invalid ?? true;
      async function* gen() {
        yield CSV_BOM + csvRow(['phone', 'first_name', 'last_name', 'reference_no', 'email', 'tags', 'valid', 'validation_error', 'consent', 'opted_out', 'created_at']);
        let after = '00000000-0000-0000-0000-000000000000';
        for (;;) {
          const { rows } = await db.query(
            `SELECT c.id, c.phone_e164, c.phone_raw, c.first_name, c.last_name, c.reference_no, c.email, c.tags, c.is_valid, c.validation_error, c.created_at,
                    (SELECT cr.status FROM consent_records cr WHERE cr.contact_id = c.id AND cr.purpose = 'general' ORDER BY cr.effective_at DESC, cr.recorded_at DESC LIMIT 1) AS consent,
                    EXISTS (SELECT 1 FROM suppressions s WHERE s.phone_e164 = c.phone_e164 AND s.lifted_at IS NULL) AS opted_out
               FROM contacts c
              WHERE c.deleted_at IS NULL AND c.id > $1 AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM group_memberships gm WHERE gm.contact_id = c.id AND gm.group_id = $2))
                AND ($3 OR c.is_valid)
              ORDER BY c.id LIMIT 1000`,
            [after, groupId, includeInvalid],
          );
          for (const r of rows) {
            yield csvRow([full ? (r.phone_e164 ?? r.phone_raw) : maskPhone(r.phone_e164), r.first_name, r.last_name, r.reference_no, r.email, r.tags,
              r.is_valid, r.validation_error, r.consent ?? 'NONE', r.opted_out, r.created_at]);
          }
          if (rows.length < 1000) break;
          after = rows[rows.length - 1].id;
        }
      }
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="contacts.csv"');
      return reply.send(Readable.from(gen()));
    },
  );

  app.post(
    '/contacts/:id/erase',
    {
      preHandler: [app.authenticate, requirePerm('contacts.delete')],
      schema: {
        tags: ['contacts'],
        summary: 'Erase a person’s data (data-protection request). Removes name, email, reference and number from the contact and its messages. Any opt-out for the number is kept so they are never messaged again.',
        params: IdParams,
        body: Type.Object({ note: Type.String({ minLength: 5, maxLength: 300 }) }, { additionalProperties: false }),
      },
    },
    async (req) =>
      withTx(db, async (tx) => {
        const c = await tx.query<{ phone_e164: string | null }>('SELECT phone_e164 FROM contacts WHERE id = $1 AND erased_at IS NULL FOR UPDATE', [req.params.id]);
        if (!c.rows[0]) throw notFound('Contact');
        const live = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND status IN ('QUEUED','LEASED','SENDING','UNKNOWN')`, [req.params.id]);
        if (live.rows[0]!.n > 0) {
          await tx.query(`UPDATE messages SET status = 'CANCELLED', last_error_category = 'CANCELLED', last_error_code = 'RECIPIENT_ERASED', finalized_at = now()
                           WHERE contact_id = $1 AND status = 'QUEUED'`, [req.params.id]);
          const still = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND status IN ('LEASED','SENDING','UNKNOWN')`, [req.params.id]);
          if (still.rows[0]!.n > 0) throw badRequest('MESSAGES_IN_FLIGHT', 'This person has messages being sent or awaiting reconciliation. Try again after they finish or are reconciled.');
        }
        await tx.query(
          `UPDATE contacts SET first_name = NULL, last_name = NULL, reference_no = NULL, email = NULL, attributes = '{}', tags = '{}',
                  phone_raw = '[erased]', phone_e164 = NULL, is_valid = false, validation_error = 'ERASED', deleted_at = coalesce(deleted_at, now()), erased_at = now()
            WHERE id = $1`,
          [req.params.id],
        );
        await tx.query(`UPDATE messages SET phone_e164 = NULL, body = '[erased]' WHERE contact_id = $1`, [req.params.id]);
        await tx.query(`UPDATE campaign_recipients SET phone_e164 = NULL, rendered_body = NULL WHERE contact_id = $1`, [req.params.id]);
        await tx.query('DELETE FROM group_memberships WHERE contact_id = $1', [req.params.id]);
        await tx.query(`UPDATE consent_records SET evidence = NULL WHERE contact_id = $1`, [req.params.id]);
        await audit(tx, { ...actor(req), action: 'contact.erased', entityType: 'contact', entityId: req.params.id, details: { note: req.body.note } });
        return { ok: true };
      }),
  );
};

export default routes;
