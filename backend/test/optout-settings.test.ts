import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

async function queueMessage(phone: string, status = 'QUEUED') {
  await ctx.db.query(`INSERT INTO messages (phone_e164, body, encoding, segment_count, status) VALUES ($1, 'hi', 'GSM7', 1, $2)`, [phone, status]);
}

describe('opt-out', () => {
  it('suppresses immediately, cancels queued messages and withdraws consent', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const c = (await m.call('POST', '/contacts', { phone: '76 11 2233', consent: { source: 'form' } })).json();
    await queueMessage('+26876112233');
    await queueMessage('+26876112233');
    await queueMessage('+26876112233', 'SUBMITTED'); // already sent: left alone
    await queueMessage('+26879999999'); // someone else: left alone

    const r = await m.call('POST', '/opt-outs', { phone: '+268 7611 2233', source: 'Replied STOP' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ already_suppressed: false, cancelled_messages: 2 });

    const { rows } = await ctx.db.query(`SELECT phone_e164, status, last_error_category FROM messages ORDER BY phone_e164, status`);
    expect(rows).toEqual([
      { phone_e164: '+26876112233', status: 'CANCELLED', last_error_category: 'SUPPRESSED' },
      { phone_e164: '+26876112233', status: 'CANCELLED', last_error_category: 'SUPPRESSED' },
      { phone_e164: '+26876112233', status: 'SUBMITTED', last_error_category: null },
      { phone_e164: '+26879999999', status: 'QUEUED', last_error_category: null },
    ]);
    const contact = (await m.call('GET', `/contacts/${c.id}`)).json();
    expect(contact).toMatchObject({ opted_out: true, consent_general: 'WITHDRAWN' });
  });

  it('is idempotent and works for numbers that are not contacts', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const phone = testPhone();
    expect((await m.call('POST', '/opt-outs', { phone, source: 'Phoned reception' })).statusCode).toBe(201);
    const again = await m.call('POST', '/opt-outs', { phone, source: 'Phoned again' });
    expect(again.statusCode).toBe(200);
    expect(again.json().already_suppressed).toBe(true);
    expect((await m.call('GET', '/suppressions')).json().total).toBe(1);
  });

  it('survives contact deletion and re-creation of the same number', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const c = (await m.call('POST', '/contacts', { phone: '78445566' })).json();
    await m.call('POST', '/opt-outs', { phone: '78445566', source: 'STOP' });
    await m.call('DELETE', `/contacts/${c.id}`);
    const again = (await m.call('POST', '/contacts', { phone: '78445566', consent: { source: 're-import' } })).json();
    expect(again.opted_out).toBe(true);
  });

  it('lifting requires a justification and leaves consent withdrawn', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const s = (await m.call('POST', '/opt-outs', { phone: testPhone(), source: 'STOP' })).json();
    expect((await m.call('POST', `/suppressions/${s.suppression_id}/lift`, { note: 'short' })).statusCode).toBe(400);
    const lifted = (await m.call('POST', `/suppressions/${s.suppression_id}/lift`, { note: 'Signed new consent form 2026-10-20' })).json();
    expect(lifted.note).toMatch(/still WITHDRAWN/);
    expect((await m.call('POST', `/suppressions/${s.suppression_id}/lift`, { note: 'Signed new consent form again' })).statusCode).toBe(404);
  });
});

describe('settings and kill switch', () => {
  it('validates settings and audits changes', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    expect((await m.call('PUT', '/settings/daily_segment_budget', { value: -1 })).statusCode).toBe(400);
    expect((await m.call('PUT', '/settings/no_such_key', { value: 1 })).statusCode).toBe(404);
    expect((await m.call('PUT', '/settings/default_country', { value: 'XX' })).statusCode).toBe(400);
    expect((await m.call('PUT', '/settings/daily_segment_budget', { value: 1500 })).json()).toEqual({ key: 'daily_segment_budget', value: 1500 });
    const audit = (await m.call('GET', '/audit-logs?action=settings.changed')).json();
    expect(audit.items[0].details).toEqual({ before: 2000, after: 1500 });
  });

  it('normalises authorised test numbers', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const r = await m.call('PUT', '/settings/test_numbers', { value: ['7612 3456', '+26876123456', '79000000'] });
    expect(r.json().value).toEqual(['+26876123456', '+26879000000']);
    expect((await m.call('PUT', '/settings/test_numbers', { value: ['123'] })).statusCode).toBe(400);
  });

  it('engages and releases the kill switch with an audit trail', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    expect((await m.call('POST', '/kill-switch', { enabled: true, reason: 'Carrier warning received' })).json().enabled).toBe(true);
    expect((await m.call('GET', '/settings')).json().kill_switch).toMatchObject({ enabled: true, reason: 'Carrier warning received' });
    await m.call('POST', '/kill-switch', { enabled: false, reason: 'Cleared with carrier' });
    const actions = (await m.call('GET', '/audit-logs?action=kill_switch.')).json().items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(['kill_switch.released', 'kill_switch.engaged']);
  });
});

describe('tools', () => {
  it('analyses SMS text and checks numbers without saving', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const a = (await m.call('POST', '/tools/sms-analyze', { text: 'Hi {{first_name}} 😀' })).json();
    expect(a).toMatchObject({ encoding: 'UCS2', segments: 1, nonGsmCharacters: ['😀'], template: { fields: ['first_name'], issues: [] } });
    const p = (await m.call('POST', '/tools/phone-check', { numbers: ['76123456', 'bad'] })).json();
    expect(p.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, false]);
    const { rows } = await ctx.db.query('SELECT count(*)::int n FROM contacts');
    expect(rows[0].n).toBe(0);
  });
});
