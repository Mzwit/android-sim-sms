import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { adminClient, makeApp, resetDb } from './helpers.js';
import { buildRow, mapHeader } from '../src/services/importer.js';
import { csvCell } from '../src/lib/csv.js';

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.db.end();
});
beforeEach(() => resetDb(ctx.db));

type Client = Awaited<ReturnType<typeof adminClient>>;

function multipart(filename: string, content: Buffer | string, fields: Record<string, string> = {}) {
  const boundary = '----smsgwtest' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(Buffer.isBuffer(content) ? content : Buffer.from(content));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(c: Client, filename: string, content: Buffer | string, fields: Record<string, string> = {}) {
  const mp = multipart(filename, content, fields);
  return ctx.app.inject({ method: 'POST', url: '/api/v1/contacts/import', payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${c.token}` } });
}

const CSV = [
  'Mobile,First Name,Surname,Student No,Email,Tags,Consent Source,Consent Date',
  '7612 3456,Thandeka,Dlamini,S1,t@example.org,student;y3,Form 2026,2026-02-01',
  '+268 7898 7654,Sibusiso,Nkambule,S2,,student,Form 2026,2026-02-03',
  '76123456,Duplicate,OfRow1,S3,,,Form 2026,2026-02-01', // same number as row 1
  '7612O456,Typo,Letter O,S4,,,,', // letter O
  '22404000,Landline,Office,S5,,,,', // fixed line
  '79111222,Bad,Email,S6,not-an-email,,,',
  '79333444,No,Consent,S7,,,,',
  '79555666,Future,Consent,S8,,,Form,2099-01-01',
  ',Empty,Phone,S9,,,,',
  '"=HYPERLINK(""http://evil"")",Formula,Inject,S10,,,,',
].join('\r\n');

describe('import', () => {
  it('maps common header names', () => {
    expect(['Mobile', 'MSISDN', 'Phone Number', 'cell'].map(mapHeader)).toEqual(['phone', 'phone', 'phone', 'phone']);
    expect(['Surname', 'Student No', 'E-mail'].map(mapHeader)).toEqual(['last_name', 'reference_no', 'email']);
  });

  it('handles Excel numbers in scientific notation', () => {
    expect(buildRow(1, { phone: 26876123456 }, 'SZ').phone_e164).toBe('+26876123456');
    expect(buildRow(1, { phone: '2.6876123456E+10' }, 'SZ').phone_e164).toBe('+26876123456');
  });

  it('previews every problem before anything is saved', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const r = await upload(m, 'students.csv', CSV);
    expect(r.statusCode).toBe(201);
    const { summary, problems, import_id } = r.json();
    expect(summary).toMatchObject({
      total_rows: 10,
      valid_rows: 4,
      invalid_rows: 6,
      duplicate_rows_in_file: 1,
      new_contacts: 3,
      existing_contacts: 0,
      invalid_by_code: { INVALID_CHARACTERS: 2, NOT_MOBILE: 1, INVALID_EMAIL: 1, FUTURE_CONSENT_DATE: 1, EMPTY: 1 },
    });
    expect(problems.map((p: any) => p.row_no)).toEqual([3, 4, 5, 6, 8, 9, 10]);
    expect(problems.find((p: any) => p.row_no === 3)).toMatchObject({ duplicate_of_row: 1, error_code: null });
    expect((await ctx.db.query('SELECT count(*)::int n FROM contacts')).rows[0].n).toBe(0);
    const csv = await m.call('GET', `/contacts/imports/${import_id}/problems.csv`);
    expect(csv.body).toContain('Same number as row 2'); // spreadsheet row numbers (header = row 1)
  });

  it('commits valid rows with consent from the file, flags invalid rows when asked, and skips duplicates', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const g = (await m.call('POST', '/groups', { name: 'Year 3' })).json();
    const { import_id } = (await upload(m, 'students.csv', CSV)).json();
    const r = await m.call('POST', `/contacts/imports/${import_id}/commit`, { group_ids: [g.id], store_invalid: true, add_tags: ['import-oct'] });
    expect(r.json()).toMatchObject({ created: 3, invalid_rows: 6, invalid_stored: 6, skipped_duplicates_in_file: 1, memberships_added: 3, consent_records: 2 });
    const contacts = (await m.call('GET', '/contacts?page_size=50')).json();
    expect(contacts.total).toBe(9);
    const t = contacts.items.find((c: any) => c.first_name === 'Thandeka');
    expect(t).toMatchObject({ phone_e164: '+26876123456', consent_general: 'GRANTED', tags: ['import-oct', 'student', 'y3'], group_ids: [g.id] });
    expect(contacts.items.find((c: any) => c.first_name === 'No').consent_general).toBeNull();
    expect(contacts.items.filter((c: any) => !c.is_valid)).toHaveLength(6);
    // Committing twice is refused.
    expect((await m.call('POST', `/contacts/imports/${import_id}/commit`, {})).json().error.code).toBe('IMPORT_NOT_STAGED');
  });

  it('re-importing matches existing contacts; update mode refreshes them', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const first = (await upload(m, 'a.csv', 'phone,first_name\n76123456,Old\n78000111,Keep\n')).json();
    await m.call('POST', `/contacts/imports/${first.import_id}/commit`, {});
    const second = (await upload(m, 'b.csv', 'phone,first_name\n+26876123456,New\n79000222,Fresh\n')).json();
    expect(second.summary).toMatchObject({ existing_contacts: 1, new_contacts: 1 });
    const r = (await m.call('POST', `/contacts/imports/${second.import_id}/commit`, { on_existing: 'update', default_consent: { source: 'Signed list, Oct 2026' } })).json();
    expect(r).toMatchObject({ created: 1, updated: 1, consent_records: 2 });
    const names = (await m.call('GET', '/contacts')).json().items.map((c: any) => c.first_name).sort();
    expect(names).toEqual(['Fresh', 'Keep', 'New']);
  });

  it('imports XLSX', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    ws.addRow(['Phone', 'First name', 'Last name']);
    ws.addRow([26876111222, 'Lindiwe', 'Mamba']);
    ws.addRow(['7811 2233', 'Zanele', 'Motsa']);
    ws.addRow(['bad', 'X', 'Y']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = (await upload(m, 'contacts.xlsx', buf)).json();
    expect(r.summary).toMatchObject({ total_rows: 3, valid_rows: 2, invalid_rows: 1 });
  });

  it('rejects files without a phone column, empty files and unsupported types', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    expect((await upload(m, 'x.csv', 'name,email\nA,a@b.c\n')).json().error.code).toBe('NO_PHONE_COLUMN');
    expect((await upload(m, 'x.csv', 'phone\n')).json().error.code).toBe('EMPTY_FILE');
    expect((await upload(m, 'x.pdf', 'phone\n1')).json().error.code).toBe('UNSUPPORTED_FILE');
  });

  it('streams a 6,000-row file within limits', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const rows = ['phone,first_name,consent_source'];
    for (let i = 0; i < 6000; i++) rows.push(`79${String(100000 + i)},P${i},Form`);
    const t = Date.now();
    const r = (await upload(m, 'big.csv', rows.join('\n'))).json();
    expect(r.summary).toMatchObject({ total_rows: 6000, valid_rows: 6000, new_contacts: 6000 });
    const c = (await m.call('POST', `/contacts/imports/${r.import_id}/commit`, {})).json();
    expect(c).toMatchObject({ created: 6000, consent_records: 6000 });
    expect(Date.now() - t).toBeLessThan(20_000);
  });
});

describe('export', () => {
  it('guards against spreadsheet formula injection but leaves phone numbers intact', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('+26876123456')).toBe('+26876123456');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('exports contacts with masking by role and audits the export', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    await m.call('POST', '/contacts', { phone: '76123456', first_name: '=cmd|calc', consent: { source: 'form' } });
    const full = await m.call('GET', '/contacts/export.csv');
    expect(full.headers['content-type']).toMatch(/text\/csv/);
    expect(full.body).toContain('+26876123456');
    expect(full.body).toContain("'=cmd|calc");
    const auditor = await adminClient(ctx.app, ctx.db, 'CAMPAIGN_MANAGER');
    await ctx.db.query(`DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE code='CAMPAIGN_MANAGER') AND permission_id = (SELECT id FROM permissions WHERE code='contacts.read_full')`);
    const masked = await auditor.call('GET', '/contacts/export.csv');
    expect(masked.body).toContain('+2687*****56');
    await ctx.db.query(`INSERT INTO role_permissions SELECT r.id, p.id FROM roles r, permissions p WHERE r.code='CAMPAIGN_MANAGER' AND p.code='contacts.read_full'`);
    const audits = (await m.call('GET', '/audit-logs?action=contacts.exported')).json();
    expect(audits.total).toBe(2);
  });

  it('serves the import template', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const t = await m.call('GET', '/contacts/import/template.csv');
    expect(t.body.split('\r\n')[0]).toBe('﻿phone,first_name,last_name,reference_no,email,tags,consent_source,consent_date');
  });
});

describe('erasure', () => {
  it('removes personal data but keeps the opt-out', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const c = (await m.call('POST', '/contacts', { phone: '76123456', first_name: 'Sipho', email: 's@example.org' })).json();
    await m.call('POST', '/opt-outs', { phone: '76123456', source: 'asked to be forgotten' });
    expect((await m.call('POST', `/contacts/${c.id}/erase`, { note: 'Data protection request #12' })).statusCode).toBe(200);
    const row = (await ctx.db.query('SELECT first_name, email, phone_e164, phone_raw, erased_at FROM contacts WHERE id = $1', [c.id])).rows[0];
    expect(row).toMatchObject({ first_name: null, email: null, phone_e164: null, phone_raw: '[erased]' });
    expect((await m.call('GET', '/suppressions')).json().total).toBe(1);
    expect((await m.call('GET', `/contacts/${c.id}`)).statusCode).toBe(404);
  });
});
