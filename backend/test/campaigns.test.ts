import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { adminClient, makeApp, resetDb, testPhone } from './helpers.js';

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

async function groupWithContacts(m: Client, n: number, opts: { consent?: boolean } = {}) {
  const g = (await m.call('POST', '/groups', { name: `G-${randomUUID().slice(0, 6)}` })).json();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await m.call('POST', '/contacts', {
      phone: testPhone(),
      first_name: `P${i}`,
      group_ids: [g.id],
      consent: opts.consent === false ? undefined : { source: 'form' },
    });
    ids.push(c.json().id);
  }
  return { group: g, ids };
}

const body = (groupId: string, extra: Record<string, unknown> = {}) => ({
  name: 'Exam timetable',
  body_template: 'Hello {{first_name|Student}}, exams start Monday 08:00.',
  group_ids: [groupId],
  cost_per_segment: 0.45,
  ...extra,
});

describe('campaign creation idempotency', () => {
  it('requires an Idempotency-Key', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const { group } = await groupWithContacts(m, 1);
    const r = await m.call('POST', '/campaigns', body(group.id));
    expect(r.statusCode).toBe(400);
  });

  it('a retried request returns the same campaign instead of creating a second', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const { group } = await groupWithContacts(m, 1);
    const key = { 'idempotency-key': randomUUID() };
    const a = await m.call('POST', '/campaigns', body(group.id), key);
    const b = await m.call('POST', '/campaigns', body(group.id), key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json().id).toBe(a.json().id);
    const { rows } = await ctx.db.query('SELECT count(*)::int n FROM campaigns');
    expect(rows[0].n).toBe(1);
  });

  it('reusing a key with a different body is rejected', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const { group } = await groupWithContacts(m, 1);
    const key = { 'idempotency-key': randomUUID() };
    await m.call('POST', '/campaigns', body(group.id), key);
    const r = await m.call('POST', '/campaigns', body(group.id, { name: 'Different' }), key);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('concurrent requests with the same key create exactly one campaign', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const { group } = await groupWithContacts(m, 1);
    const key = { 'idempotency-key': randomUUID() };
    const results = await Promise.all(Array.from({ length: 10 }, () => m.call('POST', '/campaigns', body(group.id), key)));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    const { rows } = await ctx.db.query('SELECT count(*)::int n FROM campaigns');
    expect(rows[0].n).toBe(1);
  });

  it('concurrent creation with different keys creates independent campaigns', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const other = await adminClient(ctx.app, ctx.db, 'CAMPAIGN_MANAGER');
    const { group } = await groupWithContacts(m, 1);
    const sameKey = randomUUID(); // keys are scoped per administrator
    const results = await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => m.call('POST', '/campaigns', body(group.id, { name: `C${i}` }), { 'idempotency-key': randomUUID() })),
      m.call('POST', '/campaigns', body(group.id), { 'idempotency-key': sameKey }),
      other.call('POST', '/campaigns', body(group.id), { 'idempotency-key': sameKey }),
    ]);
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(10);
  });
});

describe('campaign validation and lifecycle', () => {
  it('rejects unknown personalisation fields and over-long messages', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const { group } = await groupWithContacts(m, 1);
    const r = await m.call('POST', '/campaigns', body(group.id, { body_template: 'Hi {{id_number}}' }), { 'idempotency-key': randomUUID() });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('INVALID_TEMPLATE');
    const long = await m.call('POST', '/campaigns', body(group.id, { body_template: 'ŝ'.repeat(700) }), { 'idempotency-key': randomUUID() });
    expect(long.json().error.code).toBe('MESSAGE_TOO_LONG');
  });

  it('rejects bad schedules and unknown groups', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const { group } = await groupWithContacts(m, 1);
    const k = () => ({ 'idempotency-key': randomUUID() });
    expect((await m.call('POST', '/campaigns', body(group.id, { schedule: { window_start: '18:00', window_end: '08:00' } }), k())).json().error.code).toBe('INVALID_WINDOW');
    expect((await m.call('POST', '/campaigns', body(group.id, { schedule: { timezone: 'Mars/Olympus' } }), k())).json().error.code).toBe('INVALID_TIMEZONE');
    expect((await m.call('POST', '/campaigns', body(group.id, { schedule: { cooldown_every: 100 } }), k())).json().error.code).toBe('INVALID_COOLDOWN');
    expect((await m.call('POST', '/campaigns', body(randomUUID()), k())).json().error.code).toBe('UNKNOWN_GROUP');
  });

  it('enforces the configured recipient cap', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const { group } = await groupWithContacts(m, 1);
    const r = await m.call('POST', '/campaigns', body(group.id, { max_recipients: 50000 }), { 'idempotency-key': randomUUID() });
    expect(r.json().error.code).toBe('OVER_RECIPIENT_CAP');
  });

  it('only drafts can be edited or deleted', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const { group } = await groupWithContacts(m, 1);
    const c = (await m.call('POST', '/campaigns', body(group.id), { 'idempotency-key': randomUUID() })).json();
    expect(c.status).toBe('DRAFT');
    expect(c.schedule).toMatchObject({ timezone: 'Africa/Mbabane', window_start: '08:00', window_end: '18:00' });
    const edited = (await m.call('PATCH', `/campaigns/${c.id}`, { name: 'Renamed', schedule: { window_start: '09:00', window_end: '17:00' } })).json();
    expect(edited).toMatchObject({ name: 'Renamed', schedule: { window_start: '09:00' } });
    await ctx.db.query(`UPDATE campaigns SET status = 'APPROVED' WHERE id = $1`, [c.id]);
    expect((await m.call('PATCH', `/campaigns/${c.id}`, { name: 'x' })).json().error.code).toBe('NOT_DRAFT');
    expect((await m.call('DELETE', `/campaigns/${c.id}`)).json().error.code).toBe('NOT_DRAFT');
  });
});

describe('campaign preview (dry run)', () => {
  it('counts exclusions, segments and cost without queueing anything', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const { group, ids } = await groupWithContacts(m, 10);
    const noConsent = await groupWithContacts(m, 2, { consent: false });
    await m.call('POST', '/contacts/bulk-update', { contact_ids: noConsent.ids, add_group_ids: [group.id] });
    // Opt one consented contact out.
    const optedPhone = (await ctx.db.query('SELECT phone_e164 FROM contacts WHERE id = $1', [ids[0]])).rows[0].phone_e164;
    await m.call('POST', '/opt-outs', { phone: optedPhone, source: 'Replied STOP' });
    // An invalid contact (as an import would store it).
    const inv = await ctx.db.query(`INSERT INTO contacts (phone_raw, is_valid, validation_error) VALUES ('7612', false, 'too short') RETURNING id`);
    await ctx.db.query('INSERT INTO group_memberships (group_id, contact_id) VALUES ($1, $2)', [group.id, inv.rows[0].id]);

    const c = (await m.call('POST', '/campaigns', body(group.id), { 'idempotency-key': randomUUID() })).json();
    const p = (await m.call('POST', `/campaigns/${c.id}/preview`, { sample_size: 3 })).json();
    expect(p.summary).toMatchObject({
      candidates: 13,
      included: 9,
      excluded: { INVALID_NUMBER: 1, SUPPRESSED: 1, NO_CONSENT: 2, DUPLICATE_NUMBER: 0, OVER_LIMIT: 0 },
      segmentsTotal: 9,
      encodings: { GSM7: 9, UCS2: 0 },
    });
    expect(p.estimated_cost.amount).toBeCloseTo(4.05);
    expect(p.samples).toHaveLength(3);
    expect(p.samples[0].text).toMatch(/^Hello P\d+, exams start/);
    expect(p.warnings.join(' ')).toMatch(/missing consent/);
    const { rows } = await ctx.db.query('SELECT count(*)::int n FROM messages');
    expect(rows[0].n).toBe(0);
  });

  it('flags Unicode and multi-segment messages', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const { group } = await groupWithContacts(m, 2);
    const c = (await m.call('POST', '/campaigns', body(group.id, { body_template: '“Reminder” ' + 'x'.repeat(70) }), { 'idempotency-key': randomUUID() })).json();
    expect(c.template_analysis).toMatchObject({ encoding: 'UCS2', segments: 2 });
    const p = (await m.call('POST', `/campaigns/${c.id}/preview`, {})).json();
    expect(p.summary).toMatchObject({ segmentsTotal: 4, maxSegmentsPerMessage: 2, encodings: { UCS2: 2 } });
    expect(p.warnings.join(' ')).toMatch(/Unicode/);
  });
});
