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

describe('role-based access control', () => {
  it('viewers can read but not write', async () => {
    const viewer = await adminClient(ctx.app, ctx.db, 'VIEWER');
    expect((await viewer.call('GET', '/contacts')).statusCode).toBe(200);
    const res = await viewer.call('POST', '/contacts', { phone: testPhone() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect((await viewer.call('GET', '/audit-logs')).statusCode).toBe(403);
    expect((await viewer.call('POST', '/kill-switch', { enabled: true, reason: 'test' })).statusCode).toBe(403);
    expect((await viewer.call('GET', '/admins')).statusCode).toBe(403);
  });

  it('operators cannot approve-level actions such as changing settings or deleting contacts', async () => {
    const mgr = await adminClient(ctx.app, ctx.db, 'CAMPAIGN_MANAGER');
    const op = await adminClient(ctx.app, ctx.db, 'OPERATOR');
    const c = (await mgr.call('POST', '/contacts', { phone: testPhone() })).json();
    expect((await op.call('DELETE', `/contacts/${c.id}`)).statusCode).toBe(403);
    expect((await op.call('PUT', '/settings/daily_segment_budget', { value: 5 })).statusCode).toBe(403);
    expect((await mgr.call('DELETE', `/contacts/${c.id}`)).statusCode).toBe(200);
  });

  it('phone numbers are masked unless the role has contacts.read_full', async () => {
    const mgr = await adminClient(ctx.app, ctx.db, 'CAMPAIGN_MANAGER');
    const viewer = await adminClient(ctx.app, ctx.db, 'VIEWER');
    const created = (await mgr.call('POST', '/contacts', { phone: '76 55 4433', first_name: 'Sipho' })).json();
    expect(created.phone_e164).toBe('+26876554433');
    const seen = (await viewer.call('GET', `/contacts/${created.id}`)).json();
    expect(seen.phone_e164).toBe('+2687*****33');
    expect(seen.phone_masked).toBe(true);
    expect(seen.phone_raw).toBeUndefined();
  });

  it('the last active super administrator cannot be demoted or deactivated', async () => {
    const sa = await adminClient(ctx.app, ctx.db, 'SUPER_ADMIN');
    expect((await sa.call('PATCH', `/admins/${sa.id}`, { is_active: false })).json().error.code).toBe('SELF_LOCKOUT');
    const other = (await sa.call('POST', '/admins', { email: 'second@example.org', display_name: 'Second', role: 'SUPER_ADMIN' })).json();
    expect(other.temporary_password).toHaveLength(20);
    // Two super admins: demoting one is fine.
    expect((await sa.call('PATCH', `/admins/${other.id}`, { role: 'VIEWER' })).statusCode).toBe(200);
    // Now sa is the only one; it cannot be demoted by anyone. Simulate via a second SA that we then deactivate.
    const third = (await sa.call('POST', '/admins', { email: 'third@example.org', display_name: 'Third', role: 'CAMPAIGN_MANAGER' })).json();
    expect((await sa.call('PATCH', `/admins/${third.id}`, { role: 'SUPER_ADMIN' })).statusCode).toBe(200);
    expect((await sa.call('PATCH', `/admins/${third.id}`, { is_active: false })).statusCode).toBe(200);
    const { rows } = await ctx.db.query(`SELECT count(*)::int n FROM administrators a JOIN roles r ON r.id=a.role_id WHERE r.code='SUPER_ADMIN' AND a.is_active`);
    expect(rows[0].n).toBe(1);
  });

  it('a newly created admin must change the temporary password', async () => {
    const sa = await adminClient(ctx.app, ctx.db);
    const created = (await sa.call('POST', '/admins', { email: 'new@example.org', display_name: 'New', role: 'OPERATOR' })).json();
    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'new@example.org', password: created.temporary_password } });
    expect(login.json().must_change_password).toBe(true);
  });
});

describe('contacts', () => {
  it('normalises to E.164 and rejects the same number written differently', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const a = await m.call('POST', '/contacts', { phone: '7612 3456', first_name: 'Thandeka' });
    expect(a.statusCode).toBe(201);
    expect(a.json().phone_e164).toBe('+26876123456');
    for (const variant of ['+268 76 123 456', '0026876123456', '26876123456']) {
      const dup = await m.call('POST', '/contacts', { phone: variant });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error).toMatchObject({ code: 'DUPLICATE_PHONE', details: { existing_contact_id: a.json().id } });
    }
  });

  it('does not merge numbers that are merely similar', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    expect((await m.call('POST', '/contacts', { phone: '76123456' })).statusCode).toBe(201);
    expect((await m.call('POST', '/contacts', { phone: '76123457' })).statusCode).toBe(201);
    expect((await m.call('POST', '/contacts', { phone: '78123456' })).statusCode).toBe(201);
  });

  it('rejects invalid numbers with a reason instead of altering them', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const r = await m.call('POST', '/contacts', { phone: '7612O456' });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: 'INVALID_PHONE', details: { reason: 'INVALID_CHARACTERS', input: '7612O456' } });
    expect((await m.call('POST', '/contacts', { phone: '22404000' })).json().error.details.reason).toBe('NOT_MOBILE');
  });

  it('records consent at creation and exposes the history', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const c = (await m.call('POST', '/contacts', { phone: testPhone(), consent: { source: 'Enrolment form 2026', evidence: 'FORM-118' } })).json();
    expect(c.consent_general).toBe('GRANTED');
    const detail = (await m.call('GET', `/contacts/${c.id}`)).json();
    expect(detail.consent_history[0]).toMatchObject({ status: 'GRANTED', source: 'Enrolment form 2026', evidence: 'FORM-118' });
  });

  it('searches, filters and paginates', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const g = (await m.call('POST', '/groups', { name: 'Year 3' })).json();
    for (let i = 0; i < 25; i++) {
      await m.call('POST', '/contacts', { phone: testPhone(), first_name: i % 5 ? 'Bongani' : 'Lindiwe', last_name: 'Dlamini', tags: i % 2 ? ['student'] : [], group_ids: i < 10 ? [g.id] : [] });
    }
    const page1 = (await m.call('GET', '/contacts?page_size=10&page=1')).json();
    expect(page1).toMatchObject({ total: 25, page: 1, page_size: 10 });
    expect(page1.items).toHaveLength(10);
    expect((await m.call('GET', '/contacts?page_size=10&page=3')).json().items).toHaveLength(5);
    expect((await m.call('GET', '/contacts?q=lindiwe')).json().total).toBe(5);
    expect((await m.call('GET', '/contacts?tag=student')).json().total).toBe(12);
    expect((await m.call('GET', `/contacts?group_id=${g.id}`)).json().total).toBe(10);
    expect((await m.call('GET', '/contacts?consent=NONE')).json().total).toBe(25);
    // SQL wildcards in search are treated literally
    expect((await m.call('GET', '/contacts?q=%25')).json().total).toBe(0);
    expect((await m.call('GET', '/contacts?page_size=500')).statusCode).toBe(400);
  });

  it('bulk-updates tags and groups', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const g = (await m.call('POST', '/groups', { name: 'Bulk' })).json();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await m.call('POST', '/contacts', { phone: testPhone(), tags: ['old'] })).json().id);
    const r = (await m.call('POST', '/contacts/bulk-update', { contact_ids: ids, add_tags: ['new'], remove_tags: ['old'], add_group_ids: [g.id] })).json();
    expect(r).toMatchObject({ contacts: 5, tagged: 5, memberships_added: 5 });
    const c = (await m.call('GET', `/contacts/${ids[0]}`)).json();
    expect(c.tags).toEqual(['new']);
    expect(c.group_ids).toEqual([g.id]);
  });

  it('edits re-validate the phone and keep the audit trail', async () => {
    const m = await adminClient(ctx.app, ctx.db);
    const a = (await m.call('POST', '/contacts', { phone: testPhone() })).json();
    const b = (await m.call('POST', '/contacts', { phone: '79000111' })).json();
    expect((await m.call('PATCH', `/contacts/${a.id}`, { phone: '+26879000111' })).statusCode).toBe(409);
    expect((await m.call('PATCH', `/contacts/${a.id}`, { phone: 'abc' })).statusCode).toBe(422);
    expect((await m.call('PATCH', `/contacts/${a.id}`, { last_name: 'Simelane' })).json().last_name).toBe('Simelane');
    expect(b.id).toBeTruthy();
    const audit = (await m.call('GET', `/audit-logs?entity_type=contact&entity_id=${a.id}`)).json();
    expect(audit.items.map((i: { action: string }) => i.action)).toEqual(['contact.updated', 'contact.created']);
  });
});
