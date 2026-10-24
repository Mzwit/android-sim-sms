import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { adminClient, bulkContacts, injectCall, makeApp, pairSimulator, resetDb, runningCampaign } from './helpers.js';
import { sweepLeases } from '../src/services/dispatch.js';
import { completeCampaigns, expireDeliveryReports, startScheduledCampaigns } from '../src/workers.js';
import { GatewaySimulator, DEFAULT_POLICY } from '../src/sim/simulator.js';

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.db.end();
});
beforeEach(() => resetDb(ctx.db));

const q = <T = any>(sql: string, p: unknown[] = []) => ctx.db.query(sql, p).then((r) => r.rows as T[]);
const statusCounts = async (campaignId: string) =>
  Object.fromEntries((await q<{ status: string; n: number }>('SELECT status, count(*)::int n FROM messages WHERE campaign_id = $1 GROUP BY 1', [campaignId])).map((r) => [r.status, r.n]));

describe('pairing', () => {
  it('pairs once with a valid code and rejects reuse, unknown and expired codes', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const pc = (await admin.call('POST', '/gateways/pairing-codes', { label: 'Office phone' })).json();
    expect(pc.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(JSON.parse(pc.qr_payload)).toMatchObject({ v: 1, code: pc.code.replace('-', '') });
    expect(pc.qr_data_url).toMatch(/^data:image\/png;base64,/);
    const call = injectCall(ctx.app);
    const ok = await call('POST', '/api/v1/gateway/pair', { code: pc.code.toLowerCase() });
    expect(ok.status).toBe(201);
    expect(ok.body.config).toMatchObject({ name: 'Office phone', kill_switch: false, paused: false });
    expect((await call('POST', '/api/v1/gateway/pair', { code: pc.code })).body.error.code).toBe('PAIRING_FAILED');
    expect((await call('POST', '/api/v1/gateway/pair', { code: 'AAAAAAAAAA' })).status).toBe(400);
    const pc2 = (await admin.call('POST', '/gateways/pairing-codes', { label: 'x' })).json();
    await ctx.db.query(`UPDATE gateway_pairing_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
    expect((await call('POST', '/api/v1/gateway/pair', { code: pc2.code })).status).toBe(400);
  });

  it('gateway routes need a device token; admin tokens and revoked tokens are refused', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin);
    expect((await sim.heartbeat()).status).toBe(200);
    const asAdmin = await ctx.app.inject({ method: 'POST', url: '/api/v1/gateway/lease', headers: { authorization: `Bearer ${admin.token}` }, payload: {} });
    expect(asAdmin.statusCode).toBe(401);
    // A gateway token cannot call admin routes either.
    const asGw = await ctx.app.inject({ method: 'GET', url: '/api/v1/contacts', headers: { authorization: `Bearer ${sim.token}` } });
    expect(asGw.statusCode).toBe(401);
    await admin.call('POST', `/gateways/${sim.gatewayId}/revoke`, { reason: 'phone lost' });
    expect((await sim.heartbeat()).status).toBe(401);
  });

  it('heartbeat stores health and returns commands', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin);
    await admin.call('POST', '/kill-switch', { enabled: true, reason: 'test' });
    const hb = await sim.heartbeat({ battery_pct: 55, signal_level: 2 });
    expect(hb.body).toMatchObject({ kill_switch: true, send_interval_ms: 1000, batch_limit: 200 });
    const list = (await admin.call('GET', '/gateways')).json();
    expect(list.items[0]).toMatchObject({ online: true, sim_display_name: 'SIM 1', last_health: { battery_pct: 55, signal_level: 2 } });
  });
});

describe('end-to-end campaign through a simulated phone', () => {
  it('test message gates approval; campaign sends, receives delivery reports and completes', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin);
    const groupId = await bulkContacts(ctx.db, 25);
    await admin.call('PUT', '/settings/test_numbers', { value: ['79000001'] });
    const name = 'Welcome week';
    const c = (await admin.call('POST', '/campaigns', { name, body_template: 'Sawubona {{first_name}}! Orientation is Monday 09:00.', group_ids: [groupId], schedule: { window_start: '00:00', window_end: '23:59', days_of_week: [1, 2, 3, 4, 5, 6, 7] } }, { 'idempotency-key': randomUUID() })).json();
    expect((await admin.call('POST', `/campaigns/${c.id}/test`, { phone: '76111111' })).json().error.code).toBe('NOT_A_TEST_NUMBER');
    expect((await admin.call('POST', `/campaigns/${c.id}/test`, { phone: '7900 0001' })).statusCode).toBe(201);
    expect((await admin.call('POST', `/campaigns/${c.id}/submit`)).statusCode).toBe(200);
    // Not yet sent: approval refused.
    expect((await admin.call('POST', `/campaigns/${c.id}/approve`, { confirm_name: name })).json().error.code).toBe('TEST_REQUIRED');
    await sim.drain();
    expect((await admin.call('POST', `/campaigns/${c.id}/approve`, { confirm_name: 'wrong' })).json().error.code).toBe('CONFIRMATION_MISMATCH');
    const ap = (await admin.call('POST', `/campaigns/${c.id}/approve`, { confirm_name: name })).json();
    expect(ap).toMatchObject({ status: 'APPROVED', queued: 25 });
    // Approved but not started: nothing is leased.
    expect(await sim.runOnce()).toBe(0);
    await admin.call('POST', `/campaigns/${c.id}/start`);
    expect(await sim.drain()).toBe(25);
    expect(await statusCounts(c.id)).toEqual({ DELIVERED: 25 });
    expect(await completeCampaigns(ctx.db)).toBe(1);
    const report = (await admin.call('GET', `/campaigns/${c.id}/report`)).json();
    expect(report.totals).toMatchObject({ included: 25, submitted: 25, confirmed_delivered: 25, unknown: 0, confirmed_failed: 0 });
    expect(report.campaign.status).toBe('COMPLETED');
    const csv = await admin.call('GET', `/campaigns/${c.id}/report.csv`);
    expect(csv.body.trim().split('\n')).toHaveLength(26);
    const usage = await q('SELECT segments_submitted, messages_submitted FROM daily_usage');
    expect(usage[0]).toMatchObject({ segments_submitted: 26, messages_submitted: 26 }); // 25 + test
  });

  it('distinguishes submitted from delivered, and times out missing reports as NO_REPORT', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin, { policy: { deliveryReport: 0 } });
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 10));
    await sim.drain();
    expect(await statusCounts(id)).toEqual({ SUBMITTED: 10 });
    expect((await q(`SELECT DISTINCT delivery_state FROM messages WHERE campaign_id = $1`, [id]))[0].delivery_state).toBe('AWAITING_REPORT');
    await ctx.db.query(`UPDATE messages SET submitted_at = now() - interval '49 hours'`);
    expect(await expireDeliveryReports(ctx.db)).toBe(10);
    const p = (await admin.call('GET', `/campaigns/${id}/progress`)).json();
    expect(p).toMatchObject({ submitted: 10, confirmed_delivered: 0, no_report: 10 });
  });

  it('late delivery reports still confirm delivery', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin);
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 5));
    await sim.runOnce({ holdDeliveries: true });
    expect(await statusCounts(id)).toEqual({ SUBMITTED: 5 });
    await sim.flushDeliveries();
    expect(await statusCounts(id)).toEqual({ DELIVERED: 5 });
  });

  it('a failed delivery report marks the message FAILED (not retried automatically)', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin, { policy: { deliveryFailure: 1 } });
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 3));
    await sim.drain();
    expect(await statusCounts(id)).toEqual({ FAILED: 3 });
    expect((await q(`SELECT DISTINCT last_error_category FROM messages WHERE campaign_id = $1`, [id]))[0].last_error_category).toBe('DELIVERY_FAILURE');
    expect((await q(`SELECT count(*)::int n FROM messages WHERE status = 'QUEUED'`))[0].n).toBe(0);
  });
});

describe('the confirm step blocks sending', () => {
  async function leased(n = 3) {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin);
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, n));
    const call = injectCall(ctx.app);
    const lease = await call('POST', '/api/v1/gateway/lease', { max: 50 }, sim.token);
    expect(lease.body.jobs).toHaveLength(n);
    const confirm = (attemptId: string) => call('POST', `/api/v1/gateway/attempts/${attemptId}/confirm`, undefined, sim.token).then((r) => r.body);
    return { admin, sim, id, jobs: lease.body.jobs as any[], confirm, call };
  }

  it('after the kill switch is engaged (message requeued)', async () => {
    const { admin, jobs, confirm, id } = await leased();
    await admin.call('POST', '/kill-switch', { enabled: true, reason: 'carrier complaint' });
    expect(await confirm(jobs[0].attempt_id)).toEqual({ decision: 'DO_NOT_SEND', reason: 'KILL_SWITCH' });
    expect((await statusCounts(id)).QUEUED).toBe(1);
  });

  it('after the recipient opts out (message cancelled)', async () => {
    const { admin, jobs, confirm } = await leased();
    await admin.call('POST', '/opt-outs', { phone: jobs[0].phone, source: 'Phoned in' });
    expect(await confirm(jobs[0].attempt_id)).toMatchObject({ decision: 'DO_NOT_SEND', reason: 'RECIPIENT_SUPPRESSED' });
    expect((await q('SELECT status FROM messages WHERE id = $1', [jobs[0].message_id]))[0].status).toBe('CANCELLED');
  });

  it('after the campaign is paused or cancelled', async () => {
    const { admin, jobs, confirm, id } = await leased();
    await admin.call('POST', `/campaigns/${id}/pause`, { reason: 'typo in message' });
    expect((await confirm(jobs[0].attempt_id)).reason).toBe('CAMPAIGN_PAUSED');
    await admin.call('POST', `/campaigns/${id}/cancel`, { reason: 'event postponed' });
    expect((await confirm(jobs[1].attempt_id)).reason).toBe('CAMPAIGN_CANCELLED');
    expect(await statusCounts(id)).toMatchObject({ CANCELLED: 2 });
  });

  it('after the lease expired, and is idempotent for a confirmed attempt', async () => {
    const { jobs, confirm } = await leased();
    expect(await confirm(jobs[0].attempt_id)).toEqual({ decision: 'SEND' });
    expect(await confirm(jobs[0].attempt_id)).toEqual({ decision: 'SEND' });
    await ctx.db.query(`UPDATE messages SET lease_expires_at = now() - interval '1 second' WHERE status = 'LEASED'`);
    expect((await confirm(jobs[1].attempt_id)).reason).toBe('LEASE_EXPIRED');
  });

  it('from a different gateway', async () => {
    const { admin, jobs } = await leased(1);
    const other = await pairSimulator(ctx.app, admin, { name: 'other' });
    const r = await injectCall(ctx.app)('POST', `/api/v1/gateway/attempts/${jobs[0].attempt_id}/confirm`, undefined, other.token);
    expect(r.body).toEqual({ decision: 'DO_NOT_SEND', reason: 'UNKNOWN_ATTEMPT' });
  });

  it('emergency stop and gateway pause stop leasing', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin);
    await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 3));
    await admin.call('POST', `/gateways/${sim.gatewayId}/emergency-stop`, { reason: 'drill' });
    expect(await sim.runOnce()).toBe(0);
    expect(sim.stats.idleReasons).toEqual({ EMERGENCY_STOP: 1 });
    expect((await sim.heartbeat()).body.emergency_stop).toBe(true);
    await admin.call('POST', `/gateways/${sim.gatewayId}/resume`, { reason: 'drill over' });
    expect(await sim.runOnce()).toBe(3);
  });
});

describe('failures and retries', () => {
  it('transient failures retry with backoff, then dead-letter when attempts are exhausted', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin, { policy: { transientFailure: 1 } });
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 2));
    await sim.runOnce();
    const m = await q(`SELECT status, attempt_count, next_attempt_at > now() AS later, last_error_code FROM messages WHERE campaign_id = $1`, [id]);
    expect(m.every((x) => x.status === 'QUEUED' && x.attempt_count === 1 && x.later && x.last_error_code === 'GENERIC_FAILURE')).toBe(true);
    for (let i = 0; i < 2; i++) {
      await ctx.db.query(`UPDATE messages SET next_attempt_at = now() WHERE status = 'QUEUED'`);
      await sim.runOnce();
    }
    const after = await q(`SELECT status, attempt_count, dead_lettered_at IS NOT NULL AS dead FROM messages WHERE campaign_id = $1`, [id]);
    expect(after.every((x) => x.status === 'FAILED' && x.attempt_count === 3 && x.dead)).toBe(true);
    expect((await q(`SELECT count(*)::int n FROM retry_jobs WHERE kind = 'AUTO'`))[0].n).toBe(4);
    // Manual retry gives exactly one more attempt.
    const msg = (await admin.call('GET', `/messages?campaign_id=${id}&dead_letter=true`)).json().items[0];
    expect((await admin.call('POST', `/messages/${msg.id}/retry`, { note: 'signal restored' })).statusCode).toBe(200);
    sim.policy.transientFailure = 0;
    await sim.runOnce();
    expect((await q('SELECT status FROM messages WHERE id = $1', [msg.id]))[0].status).toBe('DELIVERED');
  });

  it('permanent rejections are never retried automatically', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin, { policy: { permanentFailure: 1 } });
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 2));
    await sim.drain();
    expect(await statusCounts(id)).toEqual({ FAILED: 2 });
    expect((await q(`SELECT DISTINCT last_error_code, dead_lettered_at FROM messages WHERE campaign_id = $1`, [id]))[0]).toEqual({ last_error_code: 'NETWORK_REJECT', dead_lettered_at: null });
    // Bulk retry only picks up temporary categories.
    expect((await admin.call('POST', `/campaigns/${id}/retry-failed`, { note: 'try again' })).json().requeued).toBe(0);
  });

  it("Android's SMS limit pauses the gateway instead of burning retries", async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin);
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 3));
    const call = injectCall(ctx.app);
    const jobs = (await call('POST', '/api/v1/gateway/lease', { max: 1 }, sim.token)).body.jobs;
    await call('POST', `/api/v1/gateway/attempts/${jobs[0].attempt_id}/confirm`, undefined, sim.token);
    await sim.sendEvents([{ id: 'e1', type: 'PART_SENT', attempt_id: jobs[0].attempt_id, part_index: 0, parts_total: 1, result_code: 5 }]);
    expect((await q('SELECT status, attempt_count FROM messages WHERE id = $1', [jobs[0].message_id]))[0]).toEqual({ status: 'QUEUED', attempt_count: 0 });
    const gw = (await admin.call('GET', '/gateways')).json().items[0];
    expect(gw.is_paused).toBe(true);
    expect(gw.pause_reason).toMatch(/LIMIT_EXCEEDED/);
    const alerts = (await admin.call('GET', '/alerts')).json().items;
    expect(alerts[0]).toMatchObject({ severity: 'CRITICAL', kind: 'GATEWAY_PAUSED' });
    expect(await sim.runOnce()).toBe(0);
    expect(id).toBeTruthy();
  });

  it('multipart messages are SUBMITTED only when every part succeeds', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin);
    await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 1), { body_template: 'x'.repeat(400) });
    const call = injectCall(ctx.app);
    const job = (await call('POST', '/api/v1/gateway/lease', {}, sim.token)).body.jobs[0];
    expect(job.segments).toBe(3);
    await call('POST', `/api/v1/gateway/attempts/${job.attempt_id}/confirm`, undefined, sim.token);
    const part = (i: number) => ({ id: `p${i}`, type: 'PART_SENT', attempt_id: job.attempt_id, part_index: i, parts_total: 3, result_code: -1 });
    await sim.sendEvents([part(0), part(1)]);
    expect((await q('SELECT status FROM messages WHERE id = $1', [job.message_id]))[0].status).toBe('SENDING');
    await sim.sendEvents([part(1), part(2)]); // duplicate part 1 is ignored
    expect((await q('SELECT status FROM messages WHERE id = $1', [job.message_id]))[0].status).toBe('SUBMITTED');
    expect((await q('SELECT segments_submitted FROM daily_usage'))[0].segments_submitted).toBe(3);
  });

  it('auto-pauses a campaign when the failure ratio crosses the threshold', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin, { policy: { permanentFailure: 0.6 }, seed: 7 });
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 40), { failure_window_size: 10, failure_pause_ratio: 0.3 });
    await sim.drain(100, 5);
    const c = (await admin.call('GET', `/campaigns/${id}`)).json();
    expect(c.status).toBe('PAUSED');
    expect(c.pause_reason).toMatch(/Auto-paused/);
    expect((await statusCounts(id)).QUEUED).toBeGreaterThan(0);
  });
});

describe('unknown outcomes and reconciliation', () => {
  it('a phone that dies after confirmation leaves UNKNOWN (never auto-retried); a late report resolves it', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin);
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 4));
    const call = injectCall(ctx.app);
    const jobs = (await call('POST', '/api/v1/gateway/lease', { max: 4 }, sim.token)).body.jobs;
    // Confirm two (phone then "dies"), never touch the other two.
    for (const j of jobs.slice(0, 2)) await call('POST', `/api/v1/gateway/attempts/${j.attempt_id}/confirm`, undefined, sim.token);
    await ctx.db.query(`UPDATE messages SET lease_expires_at = now() - interval '1 hour' WHERE campaign_id = $1`, [id]);
    expect(await sweepLeases(ctx.db)).toEqual({ requeued: 2, unknown: 2, cancelled: 0 });
    expect(await statusCounts(id)).toEqual({ QUEUED: 2, UNKNOWN: 2 });
    // The two unconfirmed ones are provably unsent and go out again; UNKNOWN ones do not.
    await sim.drain();
    expect(await statusCounts(id)).toEqual({ DELIVERED: 2, UNKNOWN: 2 });
    // The phone comes back and reports what happened to one of them.
    await sim.sendEvents([{ id: 'late', type: 'PART_SENT', attempt_id: jobs[0].attempt_id, part_index: 0, parts_total: 1, result_code: -1 }]);
    expect(await statusCounts(id)).toEqual({ DELIVERED: 2, UNKNOWN: 1, SUBMITTED: 1 });
    // The other is reconciled by an administrator.
    const unknown = (await admin.call('GET', `/messages?status=UNKNOWN&campaign_id=${id}`)).json().items[0];
    expect((await admin.call('POST', `/messages/${unknown.id}/retry`, { note: 'try again' })).json().error.code).toBe('NOT_FAILED');
    expect((await admin.call('POST', `/messages/${unknown.id}/reconcile`, { decision: 'CONFIRMED_NOT_SENT', note: 'Sent folder on the phone is empty' })).statusCode).toBe(200);
    await sim.drain();
    expect(await statusCounts(id)).toEqual({ DELIVERED: 3, SUBMITTED: 1 });
    const detail = (await admin.call('GET', `/messages/${unknown.id}`)).json();
    expect(detail.attempts.map((a: any) => a.outcome)).toEqual(['UNKNOWN', 'SUBMITTED']);
    expect(detail.reconciliations[0].decision).toBe('CONFIRMED_NOT_SENT');
  });

  it('SUBMIT_UNKNOWN from the app and CONFIRMED_SENT reconciliation is reported as inferred, not delivered', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin, { policy: { unknown: 1 } });
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 1));
    await sim.drain();
    expect(await statusCounts(id)).toEqual({ UNKNOWN: 1 });
    const m = (await admin.call('GET', `/messages?status=UNKNOWN`)).json().items[0];
    await admin.call('POST', `/messages/${m.id}/reconcile`, { decision: 'CONFIRMED_SENT', note: 'Recipient confirmed by phone call' });
    const r = (await admin.call('GET', `/campaigns/${id}/report`)).json();
    expect(r.totals).toMatchObject({ submitted: 1, confirmed_delivered: 0, reconciled_as_sent: 1, unknown: 0 });
  });

  it('released (NOT_SENT) jobs go straight back to the queue without using an attempt', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin);
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 3));
    const call = injectCall(ctx.app);
    const jobs = (await call('POST', '/api/v1/gateway/lease', {}, sim.token)).body.jobs;
    await call('POST', `/api/v1/gateway/attempts/${jobs[0].attempt_id}/confirm`, undefined, sim.token);
    const r = await call('POST', '/api/v1/gateway/release', { attempt_ids: jobs.map((j: any) => j.attempt_id), reason: 'USER_PAUSED' }, sim.token);
    expect(r.body.released).toBe(3);
    expect(await statusCounts(id)).toEqual({ QUEUED: 3 });
    expect((await q('SELECT max(attempt_count)::int n FROM messages'))[0].n).toBe(0);
  });
});

describe('queue mechanics', () => {
  it('two gateways leasing at the same time never get the same message', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const a = await pairSimulator(ctx.app, admin, { name: 'a' });
    const b = await pairSimulator(ctx.app, admin, { name: 'b' });
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 300));
    const call = injectCall(ctx.app);
    const results = await Promise.all([a, b, a, b, a, b].map((s) => call('POST', '/api/v1/gateway/lease', { max: 60 }, s.token)));
    const ids = results.flatMap((r) => r.body.jobs.map((j: any) => j.message_id));
    expect(ids.length).toBe(300);
    expect(new Set(ids).size).toBe(300);
    expect(id).toBeTruthy();
  });

  it('respects the daily segment budget', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin);
    await admin.call('PUT', '/settings/daily_segment_budget', { value: 7 });
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 10));
    await sim.drain();
    expect(await statusCounts(id)).toEqual({ DELIVERED: 7, QUEUED: 3 });
    expect(sim.stats.idleReasons.DAILY_BUDGET_REACHED).toBe(1);
  });

  it('respects the campaign budget and pauses the campaign', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin);
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 4), { budget_segments: 10 });
    await ctx.db.query(`UPDATE campaigns SET budget_segments = 2 WHERE id = $1`, [id]);
    await sim.drain();
    expect(await statusCounts(id)).toEqual({ DELIVERED: 2, QUEUED: 2 });
    expect((await admin.call('GET', `/campaigns/${id}`)).json()).toMatchObject({ status: 'PAUSED', pause_reason: 'Campaign segment budget reached' });
  });

  it('refuses to approve a campaign that exceeds its budget', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    await expect(runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 4), { budget_segments: 3 })).rejects.toThrow(/OVER_BUDGET/);
  });

  it('sends nothing outside the sending window', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin);
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 2));
    // A one-minute window twelve hours from now.
    await ctx.db.query(
      `UPDATE campaign_schedules SET window_start = ((now() AT TIME ZONE timezone) + interval '12 hours')::time,
              window_end = ((now() AT TIME ZONE timezone) + interval '12 hours 1 minute')::time WHERE campaign_id = $1`,
      [id],
    );
    expect(await sim.runOnce()).toBe(0);
    expect(sim.stats.idleReasons).toEqual({ NO_WORK: 1 });
  });

  it('applies cooldowns after N messages', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin);
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 10));
    await ctx.db.query(`UPDATE campaign_schedules SET cooldown_every = 4, cooldown_seconds = 600 WHERE campaign_id = $1`, [id]);
    await sim.drain();
    expect((await statusCounts(id)).DELIVERED).toBe(4);
    expect((await q(`SELECT cooldown_until > now() AS resting FROM campaigns WHERE id = $1`, [id]))[0].resting).toBe(true);
  });

  it('starts scheduled campaigns when their time comes', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    await ctx.db.query(`UPDATE app_settings SET value = 'false' WHERE key = 'require_test_before_approval'`);
    const g = await bulkContacts(ctx.db, 2);
    const name = 'Scheduled';
    const start = new Date(Date.now() + 3600_000).toISOString();
    const c = (await admin.call('POST', '/campaigns', { name, body_template: 'hi', group_ids: [g], schedule: { start_at: start, window_start: '00:00', window_end: '23:59', days_of_week: [1, 2, 3, 4, 5, 6, 7] } }, { 'idempotency-key': randomUUID() })).json();
    await admin.call('POST', `/campaigns/${c.id}/submit`);
    expect((await admin.call('POST', `/campaigns/${c.id}/approve`, { confirm_name: name })).json().status).toBe('SCHEDULED');
    expect(await startScheduledCampaigns(ctx.db)).toBe(0);
    await ctx.db.query(`UPDATE campaign_schedules SET start_at = now() - interval '1 second'`);
    expect(await startScheduledCampaigns(ctx.db)).toBe(1);
    expect((await admin.call('GET', `/campaigns/${c.id}`)).json().status).toBe('RUNNING');
  });

  it('approval is not repeatable and cannot double-queue', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 5));
    const c = (await admin.call('GET', `/campaigns/${id}`)).json();
    const again = await admin.call('POST', `/campaigns/${id}/approve`, { confirm_name: c.name });
    expect(again.json().error.code).toBe('INVALID_STATE');
    expect((await q('SELECT count(*)::int n FROM messages WHERE campaign_id = $1', [id]))[0].n).toBe(5);
  });

  it('requires a separate approver when configured', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    await admin.call('PUT', '/settings/require_separate_approver', { value: true });
    await expect(runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 1))).rejects.toThrow(/SEPARATE_APPROVER_REQUIRED/);
  });

  it('blocks campaigns containing generated demo contacts', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const g = await bulkContacts(ctx.db, 3);
    await ctx.db.query(`UPDATE contacts SET tags = ARRAY['SEED_DATA']`);
    await expect(runningCampaign(admin, ctx.db, g)).rejects.toThrow(/SEED_DATA_PRESENT/);
  });
});

describe('opt-outs during a campaign', () => {
  it('an SMS reply STOP suppresses the sender and cancels their queued message', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin);
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 3));
    const phone = (await q('SELECT phone_e164 FROM messages WHERE campaign_id = $1 LIMIT 1', [id]))[0].phone_e164;
    const acks = await sim.sendEvents([
      { id: 'in1', type: 'INBOUND', from: phone, body: ' stop ' },
      { id: 'in2', type: 'INBOUND', from: '+26876999999', body: 'Thanks, see you there' },
    ]);
    expect(acks.map((a: any) => a.note)).toEqual(['opted out', 'not an opt-out keyword (content discarded)']);
    await sim.drain();
    expect(await statusCounts(id)).toEqual({ DELIVERED: 2, CANCELLED: 1 });
    expect((await admin.call('GET', '/suppressions')).json().items[0]).toMatchObject({ reason: 'OPT_OUT' });
  });

  it('withdrawing consent cancels the contact’s queued messages', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const id = await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 2));
    const contactId = (await q('SELECT contact_id FROM messages WHERE campaign_id = $1 LIMIT 1', [id]))[0].contact_id;
    const r = (await admin.call('POST', `/contacts/${contactId}/consent`, { status: 'WITHDRAWN', source: 'Email request' })).json();
    expect(r.cancelled_messages).toBe(1);
  });
});

describe('dashboard', () => {
  it('summary reflects contacts, messages and gateways', async () => {
    const admin = await adminClient(ctx.app, ctx.db);
    const sim = await pairSimulator(ctx.app, admin, { policy: { deliveryReport: 0 } });
    await runningCampaign(admin, ctx.db, await bulkContacts(ctx.db, 6));
    await sim.runOnce({ max: 4 });
    const s = (await admin.call('GET', '/dashboard/summary')).json();
    expect(s.contacts).toMatchObject({ total: 6, valid: 6, consented: 6 });
    expect(s.messages).toMatchObject({ queued: 2, submitted: 4, awaiting_report: 4, confirmed_delivered: 0 });
    expect(s.gateways).toMatchObject({ total: 1, online: 1 });
    expect(s.active_campaigns[0].progress).toMatchObject({ pending: 2, submitted: 4 });
    expect(s.active_campaigns[0].progress.rate_per_minute).toBeGreaterThan(0);
  });
});

describe('simulator', () => {
  it('is reproducible for a given seed', () => {
    const a = new GatewaySimulator(injectCall(ctx.app), DEFAULT_POLICY, 99);
    const b = new GatewaySimulator(injectCall(ctx.app), DEFAULT_POLICY, 99);
    expect((a as any).rand()).toBe((b as any).rand());
  });
});
