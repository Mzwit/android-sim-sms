/**
 * Phase 7: 6,000-recipient simulated load with injected faults.
 *
 * Three simulated phones send a 6,000-recipient campaign while we inject:
 *  - random transient and permanent radio failures, unknown outcomes,
 *    missing and failed delivery reports, duplicated event batches;
 *  - a backend restart halfway through (new process, same database);
 *  - a phone that goes offline holding a leased batch (leases expire);
 *  - a phone that dies right after confirming a batch (UNKNOWN outcomes);
 *  - an opt-out and a consent withdrawal while the campaign is running.
 * Then we check that every recipient is accounted for and nothing was sent twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { adminClient, bulkContacts, injectCall, makeApp, pairSimulator, resetDb, runningCampaign, TEST_DB_URL } from './helpers.js';
import { sweepLeases } from '../src/services/dispatch.js';
import { completeCampaigns, expireDeliveryReports } from '../src/workers.js';
import type { GatewaySimulator } from '../src/sim/simulator.js';

const N = Number(process.env.LOAD_RECIPIENTS ?? 6000);

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  ctx = await makeApp();
  await resetDb(ctx.db);
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.db.end();
});

const q = <T = any>(sql: string, p: unknown[] = []) => ctx.db.query(sql, p).then((r) => r.rows as T[]);

describe(`load: ${N} recipients through 3 simulated phones with faults`, () => {
  it('accounts for every recipient and never sends a message twice', { timeout: 600_000 }, async () => {
    const t0 = Date.now();
    const admin = await adminClient(ctx.app, ctx.db);
    const policy = { transientFailure: 0.03, permanentFailure: 0.005, unknown: 0.002, deliveryReport: 0.85, deliveryFailure: 0.01, duplicateEvents: 0.05 };
    const sims: GatewaySimulator[] = [];
    for (let i = 0; i < 3; i++) sims.push(await pairSimulator(ctx.app, admin, { name: `phone-${i}`, seed: 100 + i, policy }));
    await admin.call('PUT', '/settings/daily_segment_budget', { value: 1_000_000 });
    await admin.call('PUT', '/settings/max_campaign_recipients', { value: 20000 });
    await admin.call('PUT', '/settings/retry_policy', { value: { base_seconds: 5, max_seconds: 10 } });
    const groupId = await bulkContacts(ctx.db, N);
    const tSetup = Date.now();
    const campaignId = await runningCampaign(admin, ctx.db, groupId, {
      body_template: 'Sawubona {{first_name}}, exams start on Monday at 08:00 in the Main Hall. Bring your student card. Reply STOP to opt out.',
      max_recipients: 20000,
      failure_window_size: 500,
      failure_pause_ratio: 0.5,
    });
    const tQueued = Date.now();
    expect((await q('SELECT count(*)::int n FROM messages WHERE campaign_id = $1', [campaignId]))[0].n).toBe(N);

    // Mid-campaign opt-out (by SMS reply) and consent withdrawal.
    const [optOut, withdraw] = await q<{ phone_e164: string; contact_id: string }>(
      `SELECT phone_e164, contact_id FROM messages WHERE campaign_id = $1 ORDER BY queued_at DESC, id DESC LIMIT 2`,
      [campaignId],
    );

    let round = 0;
    let restarted = false;
    let offlineDone = false;
    let crashDone = false;
    let crashedConfirmed = 0;
    let optOutAt: Date | undefined;
    for (;;) {
      round++;
      const pending = (await q(`SELECT count(*)::int n FROM messages WHERE campaign_id = $1 AND status IN ('QUEUED','LEASED','SENDING')`, [campaignId]))[0].n;
      const submitted = (await q(`SELECT count(*)::int n FROM messages WHERE campaign_id = $1 AND submitted_at IS NOT NULL`, [campaignId]))[0].n;
      if (pending === 0) break;
      if (round > 2000) throw new Error('did not converge');

      if (!restarted && submitted > N / 2) {
        // Backend restart: a brand-new app instance on the same database.
        await ctx.app.close();
        await ctx.db.end();
        ctx = await makeApp();
        for (const s of sims) (s as any).call = injectCall(ctx.app);
        admin.call = (method, url, payload, headers = {}) =>
          ctx.app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: { authorization: `Bearer ${admin.token}`, ...headers } });
        restarted = true;
        optOutAt = new Date();
        await sims[0]!.sendEvents([{ id: 'stop-1', type: 'INBOUND', from: optOut!.phone_e164, body: 'STOP' }]);
        await admin.call('POST', `/contacts/${withdraw!.contact_id}/consent`, { status: 'WITHDRAWN', source: 'Email to registrar' });
      }

      if (!offlineDone && submitted > N / 4) {
        // Phone 2 leases a batch then vanishes without confirming anything.
        const r = await injectCall(ctx.app)('POST', '/api/v1/gateway/lease', { max: 40 }, sims[2]!.token);
        expect(r.body.jobs.length).toBeGreaterThan(0);
        offlineDone = true;
      }
      if (!crashDone && submitted > (3 * N) / 4) {
        // Phone 1 confirms a batch and dies before reporting anything.
        const before = sims[1]!.stats.confirmed;
        await sims[1]!.runOnce({ max: 25, crashAfterConfirm: true });
        crashedConfirmed = sims[1]!.stats.confirmed - before;
        crashDone = true;
      }

      // The two healthy phones work in parallel.
      const active = offlineDone ? [sims[0]!, sims[1]!] : sims;
      const leased = await Promise.all(active.map((s) => s.runOnce({ max: 200 })));
      if (process.env.LOAD_DEBUG) console.log('round', round, 'pending', pending, 'leased', leased.join(','), JSON.stringify(sims.map((x) => x.stats.refusedReasons)));
      if (leased.every((n) => n === 0)) {
        // Nothing ready: let time pass (expire leases, release retry backoffs).
        await ctx.db.query(`UPDATE messages SET lease_expires_at = now() - interval '1 hour' WHERE campaign_id = $1 AND status IN ('LEASED','SENDING')`, [campaignId]);
        await ctx.db.query(`UPDATE messages SET next_attempt_at = now() WHERE campaign_id = $1 AND status = 'QUEUED'`, [campaignId]);
        await sweepLeases(ctx.db);
        if ((await q(`SELECT status FROM campaigns WHERE id = $1`, [campaignId]))[0].status === 'PAUSED') {
          await admin.call('POST', `/campaigns/${campaignId}/resume`);
        }
      }
    }
    const tSent = Date.now();
    await expireDeliveryReports(ctx.db);
    expect(await completeCampaigns(ctx.db)).toBe(1);

    // ---------- the checks that matter ----------
    const counts = Object.fromEntries(
      (await q<{ status: string; n: number }>('SELECT status, count(*)::int n FROM messages WHERE campaign_id = $1 GROUP BY 1', [campaignId])).map((r) => [r.status, r.n]),
    );
    const total = Object.values(counts).reduce((a: number, b) => a + (b as number), 0);
    // 1. No queue record lost.
    expect(total).toBe(N);
    expect((await q(`SELECT count(*)::int n FROM campaign_recipients WHERE campaign_id = $1 AND decision = 'INCLUDED'`, [campaignId]))[0].n).toBe(N);
    // 2. Nothing left in flight.
    expect(counts.QUEUED ?? 0).toBe(0);
    expect(counts.LEASED ?? 0).toBe(0);
    expect(counts.SENDING ?? 0).toBe(0);
    // 3. No message was submitted more than once.
    const dup = await q(`SELECT message_id, count(*)::int n FROM sms_submission_attempts a JOIN messages m ON m.id = a.message_id
                          WHERE m.campaign_id = $1 AND a.outcome = 'SUBMITTED' GROUP BY 1 HAVING count(*) > 1`, [campaignId]);
    expect(dup).toEqual([]);
    // 4. Every confirmed attempt has an outcome; unconfirmed attempts were never "sent".
    const orphan = await q(`SELECT count(*)::int n FROM sms_submission_attempts a JOIN messages m ON m.id = a.message_id
                             WHERE m.campaign_id = $1 AND a.outcome = 'PENDING'`, [campaignId]);
    expect(orphan[0].n).toBe(0);
    expect((await q(`SELECT count(*)::int n FROM sms_submission_attempts a JOIN messages m ON m.id = a.message_id
                      WHERE m.campaign_id = $1 AND a.confirmed_at IS NULL AND a.outcome IN ('SUBMITTED','FAILED')`, [campaignId]))[0].n).toBe(0);
    // 5. UNKNOWN = phone crash after confirm + simulated unknowns. Never auto-retried.
    const simUnknown = sims.reduce((a, s) => a + s.stats.unknown, 0);
    expect(counts.UNKNOWN).toBe(crashedConfirmed + simUnknown);
    // 6. Opt-out and withdrawal honoured.
    //    No attempt to either recipient was confirmed for sending after the opt-out / withdrawal.
    const late = await q(
      `SELECT count(*)::int n FROM sms_submission_attempts a JOIN messages m ON m.id = a.message_id
        WHERE m.campaign_id = $1 AND (m.phone_e164 = $2 OR m.contact_id = $3) AND a.confirmed_at > $4`,
      [campaignId, optOut!.phone_e164, withdraw!.contact_id, optOutAt],
    );
    expect(late[0].n).toBe(0);
    expect((await q(`SELECT count(*)::int n FROM suppressions WHERE phone_e164 = $1 AND lifted_at IS NULL`, [optOut!.phone_e164]))[0].n).toBe(1);
    // 7. Report is consistent with the table.
    const report = (await admin.call('GET', `/campaigns/${campaignId}/report`)).json();
    expect(report.totals.submitted + report.totals.confirmed_failed + report.totals.unknown + report.totals.cancelled).toBe(N);
    expect(report.totals.confirmed_delivered).toBe(counts.DELIVERED);

    const sentPerMin = Math.round(((counts.SUBMITTED ?? 0) + (counts.DELIVERED ?? 0)) / ((tSent - tQueued) / 60_000));
    // eslint-disable-next-line no-console
    console.log(
      `\nLOAD TEST (${N} recipients): setup ${((tSetup - t0) / 1000).toFixed(1)}s, approve+queue ${((tQueued - tSetup) / 1000).toFixed(1)}s, ` +
        `send loop ${((tSent - tQueued) / 1000).toFixed(1)}s in ${round} rounds (~${sentPerMin}/min server-side, no phone pacing)\n` +
        `final: ${JSON.stringify(counts)}; delivery: ${JSON.stringify(report.totals.submitted_no_report)} no-report; ` +
        `retries auto=${report.totals.automatic_retries}; unknown from crash=${crashedConfirmed}, simulated=${simUnknown}; restarted=${restarted}\n`,
    );
  });
});

const pgDump = ['pg_dump', '/usr/lib/postgresql/16/bin/pg_dump'].find((p) => {
  try {
    execFileSync(p, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});

describe.skipIf(!pgDump)('backup and recovery', () => {
  it('pg_dump / pg_restore round-trips every table', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'smsgw-backup-'));
    const file = path.join(dir, 'backup.dump');
    const restoreDb = 'smsgw_restore_test';
    const url = new URL(TEST_DB_URL);
    const restoreUrl = new URL(TEST_DB_URL);
    restoreUrl.pathname = `/${restoreDb}`;
    const admin = new pg.Client({ connectionString: TEST_DB_URL });
    await admin.connect();
    try {
      execFileSync(pgDump!, ['-Fc', '-f', file, url.toString()]);
      expect(existsSync(file)).toBe(true);
      await admin.query(`DROP DATABASE IF EXISTS ${restoreDb}`);
      await admin.query(`CREATE DATABASE ${restoreDb}`);
      const pgRestore = pgDump!.replace(/pg_dump$/, 'pg_restore');
      execFileSync(pgRestore, ['--no-owner', '--single-transaction', '-d', restoreUrl.toString(), file]);
      const r = new pg.Client({ connectionString: restoreUrl.toString() });
      await r.connect();
      try {
        for (const t of ['contacts', 'messages', 'sms_submission_attempts', 'delivery_reports', 'audit_logs', 'campaign_recipients', 'schema_migrations']) {
          const a = (await ctx.db.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
          const b = (await r.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
          expect({ t, n: b }).toEqual({ t, n: a });
        }
        // The append-only guard survives the restore.
        await expect(r.query(`DELETE FROM audit_logs`)).rejects.toThrow(/retention purge/);
      } finally {
        await r.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${restoreDb}`).catch(() => undefined);
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
