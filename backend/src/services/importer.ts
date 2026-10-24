/**
 * Two-step contact import:
 *   1. stage   – stream the file (CSV or XLSX) row by row into contact_import_rows,
 *                normalising numbers and recording every problem. Nothing touches
 *                contacts yet. Memory use is bounded by the batch size, not the file.
 *   2. commit  – set-based SQL turns staged rows into contacts, memberships and
 *                consent records in one transaction.
 * Invalid rows are never silently dropped: they are reported, and optionally
 * stored as invalid contacts so they can be fixed later.
 */
import { parse } from 'csv-parse';
import ExcelJS from 'exceljs';
import type { Readable } from 'node:stream';
import type { Db, Tx } from '../db.js';
import { withTx } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { normalizePhone } from '../lib/phone.js';

export const MAX_IMPORT_ROWS = 50_000;
const BATCH = 500;

const HEADER_ALIASES: Record<string, string> = {
  phone: 'phone', mobile: 'phone', msisdn: 'phone', cell: 'phone', cellphone: 'phone', phone_number: 'phone', phonenumber: 'phone', number: 'phone', mobile_number: 'phone',
  first_name: 'first_name', firstname: 'first_name', first: 'first_name', given_name: 'first_name', name: 'first_name',
  last_name: 'last_name', lastname: 'last_name', surname: 'last_name', family_name: 'last_name',
  reference_no: 'reference_no', reference: 'reference_no', ref: 'reference_no', reference_number: 'reference_no', student_no: 'reference_no',
  student_number: 'reference_no', member_no: 'reference_no', member_number: 'reference_no', staff_no: 'reference_no',
  email: 'email', email_address: 'email', e_mail: 'email',
  tags: 'tags', tag: 'tags',
  consent_source: 'consent_source', consent: 'consent_source',
  consent_date: 'consent_date', consented_at: 'consent_date', consent_given: 'consent_date',
};

export function mapHeader(h: string): string | undefined {
  const k = h.trim().toLowerCase().replace(/[\s\-./]+/g, '_').replace(/[^a-z_]/g, '');
  return HEADER_ALIASES[k];
}

interface StagedRow {
  row_no: number;
  phone_raw: string | null;
  phone_e164: string | null;
  first_name: string | null;
  last_name: string | null;
  reference_no: string | null;
  email: string | null;
  tags: string[];
  consent_source: string | null;
  consent_date: Date | null;
  error_code: string | null;
  error_message: string | null;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TAG = /^[A-Za-z0-9_\- ]{1,40}$/;

function clean(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object' && v && 'text' in (v as Record<string, unknown>)) s = String((v as { text: unknown }).text);
  else if (typeof v === 'object' && v && 'result' in (v as Record<string, unknown>)) s = String((v as { result: unknown }).result);
  else s = String(v);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return s ? s.slice(0, max) : null;
}

/** Excel stores long numbers as floats: 26876123456 may arrive as 26876123456 or 2.6876123456E10. */
function phoneFromCell(v: unknown): string | null {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(0);
  const s = clean(v, 40);
  if (s && /^\d(\.\d+)?E\+\d+$/i.test(s)) return Number(s).toFixed(0);
  return s;
}

export function buildRow(rowNo: number, rec: Record<string, unknown>, country: string): StagedRow {
  const phoneRaw = phoneFromCell(rec.phone);
  const row: StagedRow = {
    row_no: rowNo,
    phone_raw: phoneRaw,
    phone_e164: null,
    first_name: clean(rec.first_name, 80),
    last_name: clean(rec.last_name, 80),
    reference_no: clean(rec.reference_no, 60),
    email: clean(rec.email, 254),
    tags: [],
    consent_source: clean(rec.consent_source, 200),
    consent_date: null,
    error_code: null,
    error_message: null,
  };
  const err = (code: string, msg: string) => {
    if (!row.error_code) {
      row.error_code = code;
      row.error_message = msg;
    }
  };
  const n = normalizePhone(phoneRaw, country);
  if (n.ok) row.phone_e164 = n.e164;
  else err(n.error, n.message);
  if (row.email && !EMAIL.test(row.email)) err('INVALID_EMAIL', `Invalid email "${row.email}"`);
  const tagsRaw = clean(rec.tags, 500);
  if (tagsRaw) {
    for (const t of tagsRaw.split(/[;,|]/).map((x) => x.trim()).filter(Boolean)) {
      if (TAG.test(t)) row.tags.push(t);
      else err('INVALID_TAG', `Tag "${t.slice(0, 40)}" may only contain letters, digits, space, - and _`);
    }
    row.tags = [...new Set(row.tags)].slice(0, 30);
  }
  const cd = rec.consent_date;
  if (cd !== undefined && cd !== null && cd !== '') {
    const d = cd instanceof Date ? cd : new Date(String(cd).trim());
    if (Number.isNaN(d.getTime())) err('INVALID_CONSENT_DATE', `Consent date "${String(cd).slice(0, 30)}" is not a date (use YYYY-MM-DD)`);
    else if (d.getTime() > Date.now() + 86_400_000) err('FUTURE_CONSENT_DATE', 'Consent date is in the future');
    else row.consent_date = d;
  }
  if (row.consent_date && !row.consent_source) row.consent_source = 'Imported file';
  return row;
}

async function insertBatch(tx: Tx, importId: string, rows: StagedRow[]) {
  if (!rows.length) return;
  const col = <K extends keyof StagedRow>(k: K) => rows.map((r) => r[k]);
  await tx.query(
    `INSERT INTO contact_import_rows (import_id, row_no, phone_raw, phone_e164, first_name, last_name, reference_no, email, tags,
                                      consent_source, consent_date, error_code, error_message)
     SELECT $1, u.row_no, u.phone_raw, u.phone_e164, u.first_name, u.last_name, u.reference_no, u.email,
            CASE WHEN u.tags = '' THEN '{}'::text[] ELSE string_to_array(u.tags, chr(31)) END,
            u.consent_source, u.consent_date, u.error_code, u.error_message
       FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[],
                   $11::timestamptz[], $12::text[], $13::text[])
         AS u(row_no, phone_raw, phone_e164, first_name, last_name, reference_no, email, tags, consent_source, consent_date, error_code, error_message)`,
    [
      importId, col('row_no'), col('phone_raw'), col('phone_e164'), col('first_name'), col('last_name'), col('reference_no'), col('email'),
      rows.map((r) => r.tags.join('\u001f')), col('consent_source'), col('consent_date'), col('error_code'), col('error_message'),
    ],
  );
}

async function* csvRecords(stream: Readable): AsyncGenerator<Record<string, unknown>> {
  const parser = stream.pipe(
    parse({ bom: true, columns: (h: string[]) => h.map((x) => mapHeader(x) ?? `_ignored_${x}`), skip_empty_lines: true, trim: true, relax_column_count: true, max_record_size: 10_000 }),
  );
  for await (const rec of parser) yield rec as Record<string, unknown>;
}

async function* xlsxRecords(stream: Readable): AsyncGenerator<Record<string, unknown>> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(stream, { sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'cache', worksheets: 'emit' });
  for await (const sheet of reader) {
    let headers: (string | undefined)[] | undefined;
    for await (const row of sheet) {
      const values = (row.values as unknown[]).slice(1); // ExcelJS rows are 1-based
      if (!headers) {
        headers = values.map((v) => (v == null ? undefined : mapHeader(String(clean(v, 100) ?? ''))));
        continue;
      }
      if (values.every((v) => v === null || v === undefined || v === '')) continue;
      const rec: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        if (h && rec[h] === undefined) rec[h] = values[i];
      });
      yield rec;
    }
    break; // first worksheet only
  }
}

export interface ImportSummary {
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  invalid_by_code: Record<string, number>;
  duplicate_rows_in_file: number;
  existing_contacts: number;
  new_contacts: number;
  rows_with_consent: number;
  columns_detected: string[];
}

export async function stageImport(db: Db, file: { stream: Readable; filename: string }, country: string, adminId: string, ip: string) {
  const isXlsx = /\.xlsx$/i.test(file.filename);
  if (!isXlsx && !/\.(csv|txt)$/i.test(file.filename)) throw badRequest('UNSUPPORTED_FILE', 'Upload a .csv or .xlsx file');
  const importId = (
    await db.query<{ id: string }>(
      `INSERT INTO contact_imports (filename, file_type, country, uploaded_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [file.filename.slice(0, 200), isXlsx ? 'XLSX' : 'CSV', country, adminId],
    )
  ).rows[0]!.id;
  const columns = new Set<string>();
  let n = 0;
  try {
    await withTx(db, async (tx) => {
      let batch: StagedRow[] = [];
      const records = isXlsx ? xlsxRecords(file.stream) : csvRecords(file.stream);
      for await (const rec of records) {
        if (n === 0) Object.keys(rec).filter((k) => !k.startsWith('_ignored_')).forEach((k) => columns.add(k));
        n++;
        if (n > MAX_IMPORT_ROWS) throw badRequest('TOO_MANY_ROWS', `Files are limited to ${MAX_IMPORT_ROWS} rows; split the file`);
        batch.push(buildRow(n, rec, country));
        if (batch.length >= BATCH) {
          await insertBatch(tx, importId, batch);
          batch = [];
        }
      }
      await insertBatch(tx, importId, batch);
      if (n === 0) throw badRequest('EMPTY_FILE', 'The file has no data rows');
      if (!columns.has('phone')) throw badRequest('NO_PHONE_COLUMN', 'No phone column found. Name a column "phone" (or mobile, msisdn, cell).');

      // Duplicates within the file: the first occurrence wins, later ones point at it.
      await tx.query(
        `UPDATE contact_import_rows r SET duplicate_of_row = d.first_row
           FROM (SELECT row_no, min(row_no) OVER (PARTITION BY phone_e164) AS first_row
                   FROM contact_import_rows WHERE import_id = $1 AND phone_e164 IS NOT NULL AND error_code IS NULL) d
          WHERE r.import_id = $1 AND r.row_no = d.row_no AND d.first_row <> d.row_no`,
        [importId],
      );
      await tx.query(
        `UPDATE contact_import_rows r SET existing_contact_id = c.id
           FROM contacts c WHERE r.import_id = $1 AND c.phone_e164 = r.phone_e164 AND c.deleted_at IS NULL`,
        [importId],
      );
    });
  } catch (err) {
    await db.query(`UPDATE contact_imports SET status = 'DISCARDED' WHERE id = $1`, [importId]);
    throw err;
  }
  const summary = await summarizeImport(db, importId, [...columns]);
  await db.query('UPDATE contact_imports SET summary = $2 WHERE id = $1', [importId, JSON.stringify(summary)]);
  await audit(db, { actorType: 'ADMIN', actorId: adminId, ip, action: 'contacts.import_staged', entityType: 'import', entityId: importId, details: { filename: file.filename, ...summary } });
  return { import_id: importId, summary, problems: await importProblems(db, importId, 200, 0) };
}

async function summarizeImport(q: Db | Tx, importId: string, columns: string[]): Promise<ImportSummary> {
  const { rows } = await q.query<{ total: number; valid: number; invalid: number; dup: number; existing: number; fresh: number; consent: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE error_code IS NULL)::int AS valid,
            count(*) FILTER (WHERE error_code IS NOT NULL)::int AS invalid,
            count(*) FILTER (WHERE duplicate_of_row IS NOT NULL)::int AS dup,
            count(*) FILTER (WHERE error_code IS NULL AND duplicate_of_row IS NULL AND existing_contact_id IS NOT NULL)::int AS existing,
            count(*) FILTER (WHERE error_code IS NULL AND duplicate_of_row IS NULL AND existing_contact_id IS NULL)::int AS fresh,
            count(*) FILTER (WHERE consent_source IS NOT NULL OR consent_date IS NOT NULL)::int AS consent
       FROM contact_import_rows WHERE import_id = $1`,
    [importId],
  );
  const by = await q.query<{ error_code: string; n: number }>(
    `SELECT error_code, count(*)::int AS n FROM contact_import_rows WHERE import_id = $1 AND error_code IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`,
    [importId],
  );
  const r = rows[0]!;
  return {
    total_rows: r.total,
    valid_rows: r.valid,
    invalid_rows: r.invalid,
    invalid_by_code: Object.fromEntries(by.rows.map((x) => [x.error_code, x.n])),
    duplicate_rows_in_file: r.dup,
    existing_contacts: r.existing,
    new_contacts: r.fresh,
    rows_with_consent: r.consent,
    columns_detected: columns,
  };
}

export async function importProblems(q: Db | Tx, importId: string, limit: number, offset: number) {
  const { rows } = await q.query(
    `SELECT row_no, phone_raw, first_name, last_name, error_code, error_message, duplicate_of_row,
            (existing_contact_id IS NOT NULL) AS matches_existing
       FROM contact_import_rows WHERE import_id = $1 AND (error_code IS NOT NULL OR duplicate_of_row IS NOT NULL)
      ORDER BY row_no LIMIT $2 OFFSET $3`,
    [importId, limit, offset],
  );
  return rows;
}

export interface CommitOptions {
  on_existing: 'skip' | 'update';
  group_ids: string[];
  add_tags: string[];
  store_invalid: boolean;
  /** Applied to rows that have no consent columns. null = rows without consent get no consent record. */
  default_consent: { source: string; evidence?: string; effective_at?: string } | null;
}

export async function commitImport(db: Db, importId: string, o: CommitOptions, actor: { actorId: string; ip: string }) {
  return withTx(db, async (tx) => {
    const imp = await tx.query<{ status: string; uploaded_by: string }>('SELECT status, uploaded_by FROM contact_imports WHERE id = $1 FOR UPDATE', [importId]);
    if (!imp.rows[0]) throw notFound('Import');
    if (imp.rows[0].status !== 'STAGED') throw conflict('IMPORT_NOT_STAGED', `This import is already ${imp.rows[0].status}`);
    if (o.group_ids.length) {
      const g = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM contact_groups WHERE id = ANY($1::uuid[])', [o.group_ids]);
      if (g.rows[0]!.n !== o.group_ids.length) throw badRequest('UNKNOWN_GROUP', 'One or more group_ids do not exist');
    }
    // Re-check existing matches: contacts may have been added since staging.
    await tx.query(
      `UPDATE contact_import_rows r SET existing_contact_id = c.id FROM contacts c
        WHERE r.import_id = $1 AND c.phone_e164 = r.phone_e164 AND c.deleted_at IS NULL AND r.existing_contact_id IS NULL`,
      [importId],
    );

    const created = await tx.query<{ id: string; phone_e164: string }>(
      `INSERT INTO contacts (phone_e164, phone_raw, is_valid, first_name, last_name, reference_no, email, tags, created_by)
       SELECT phone_e164, coalesce(phone_raw, ''), true, first_name, last_name, reference_no, email,
              ARRAY(SELECT DISTINCT t FROM unnest(tags || $2::text[]) t ORDER BY t), $3
         FROM contact_import_rows
        WHERE import_id = $1 AND error_code IS NULL AND duplicate_of_row IS NULL AND existing_contact_id IS NULL
        ORDER BY row_no
       ON CONFLICT (phone_e164) WHERE deleted_at IS NULL AND phone_e164 IS NOT NULL DO NOTHING
       RETURNING id, phone_e164`,
      [importId, o.add_tags, actor.actorId],
    );
    await tx.query(
      `UPDATE contact_import_rows r SET existing_contact_id = c.id FROM contacts c
        WHERE r.import_id = $1 AND c.phone_e164 = r.phone_e164 AND c.deleted_at IS NULL AND r.error_code IS NULL AND r.duplicate_of_row IS NULL
          AND c.id = ANY($2::uuid[])`,
      [importId, created.rows.map((r) => r.id)],
    );
    let updated = 0;
    if (o.on_existing === 'update') {
      const u = await tx.query(
        `UPDATE contacts c SET first_name = coalesce(r.first_name, c.first_name), last_name = coalesce(r.last_name, c.last_name),
                reference_no = coalesce(r.reference_no, c.reference_no), email = coalesce(r.email, c.email),
                tags = ARRAY(SELECT DISTINCT t FROM unnest(c.tags || r.tags || $2::text[]) t ORDER BY t)
           FROM contact_import_rows r
          WHERE r.import_id = $1 AND r.error_code IS NULL AND r.duplicate_of_row IS NULL AND r.existing_contact_id = c.id
            AND NOT (c.id = ANY($3::uuid[]))`,
        [importId, o.add_tags, created.rows.map((r) => r.id)],
      );
      updated = u.rowCount ?? 0;
    }
    let invalidStored = 0;
    if (o.store_invalid) {
      const inv = await tx.query(
        `INSERT INTO contacts (phone_e164, phone_raw, is_valid, validation_error, first_name, last_name, reference_no, email, tags, created_by)
         SELECT NULL, coalesce(phone_raw, ''), false, error_code || ': ' || error_message, first_name, last_name, reference_no,
                CASE WHEN email ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' THEN email END, tags || $2::text[], $3
           FROM contact_import_rows WHERE import_id = $1 AND error_code IS NOT NULL ORDER BY row_no
         RETURNING id`,
        [importId, o.add_tags, actor.actorId],
      );
      invalidStored = inv.rowCount ?? 0;
    }
    // Every valid row's contact (new or existing) goes into the chosen groups.
    let memberships = 0;
    if (o.group_ids.length) {
      const m = await tx.query(
        `INSERT INTO group_memberships (group_id, contact_id, added_by)
         SELECT g, r.existing_contact_id, $3 FROM contact_import_rows r CROSS JOIN unnest($2::uuid[]) g
          WHERE r.import_id = $1 AND r.error_code IS NULL AND r.duplicate_of_row IS NULL AND r.existing_contact_id IS NOT NULL
            AND (r.existing_contact_id = ANY($4::uuid[]) OR $5)
         ON CONFLICT DO NOTHING`,
        [importId, o.group_ids, actor.actorId, created.rows.map((r) => r.id), o.on_existing === 'update'],
      );
      memberships = m.rowCount ?? 0;
    }
    // Consent: per-row columns win; otherwise the default consent if given.
    const consent = await tx.query(
      `INSERT INTO consent_records (contact_id, purpose, status, source, evidence, effective_at, recorded_by)
       SELECT r.existing_contact_id, 'general', 'GRANTED',
              coalesce(r.consent_source, $2), CASE WHEN r.consent_source IS NULL THEN $3 ELSE 'Imported file, row ' || (r.row_no + 1) END,
              coalesce(r.consent_date, $4::timestamptz, now()), $5
         FROM contact_import_rows r
        WHERE r.import_id = $1 AND r.error_code IS NULL AND r.duplicate_of_row IS NULL AND r.existing_contact_id IS NOT NULL
          AND (r.existing_contact_id = ANY($6::uuid[]) OR $7)
          AND (r.consent_source IS NOT NULL OR $2::text IS NOT NULL)`,
      [
        importId,
        o.default_consent?.source ?? null,
        o.default_consent?.evidence ?? null,
        o.default_consent?.effective_at ?? null,
        actor.actorId,
        created.rows.map((r) => r.id),
        o.on_existing === 'update',
      ],
    );
    const summary = (await tx.query<{ summary: ImportSummary }>('SELECT summary FROM contact_imports WHERE id = $1', [importId])).rows[0]!.summary;
    const result = {
      created: created.rowCount ?? 0,
      updated,
      skipped_existing: o.on_existing === 'skip' ? summary.existing_contacts : 0,
      skipped_duplicates_in_file: summary.duplicate_rows_in_file,
      invalid_rows: summary.invalid_rows,
      invalid_stored: invalidStored,
      memberships_added: memberships,
      consent_records: consent.rowCount ?? 0,
    };
    await tx.query(`UPDATE contact_imports SET status = 'COMMITTED', committed_at = now(), result = $2 WHERE id = $1`, [importId, JSON.stringify(result)]);
    await audit(tx, { actorType: 'ADMIN', actorId: actor.actorId, ip: actor.ip, action: 'contacts.import_committed', entityType: 'import', entityId: importId, details: { ...result, options: o } });
    return result;
  });
}
