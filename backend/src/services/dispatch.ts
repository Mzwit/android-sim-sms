/**
 * The message queue as seen by a gateway (Android phone).
 *
 * Safety model (the "never double-send" rule):
 *   1. lease     – the server hands a phone a small batch of QUEUED messages.
 *                  Status -> LEASED. Nothing has been sent.
 *   2. confirm   – immediately before sending each one, the phone asks the
 *                  server. The server re-checks the kill switch, pauses,
 *                  suppression, campaign state and lease expiry, then marks it
 *                  SENDING. The phone NEVER sends without this confirmation,
 *                  so a message that was never confirmed was never sent.
 *   3. results   – the phone reports per-part sentIntent results and, later,
 *                  per-part delivery reports. Every event carries the attempt
 *                  id, so duplicates are harmless.
 *   4. sweeper   – LEASED past expiry  -> back to QUEUED (provably unsent).
 *                  SENDING with no result long after expiry -> UNKNOWN, which
 *                  is never retried automatically. A late definitive report
 *                  still resolves an UNKNOWN.
 */
import type { Db, Queryable, Tx } from '../db.js';
import { withTx } from '../db.js';
import { audit } from '../lib/audit.js';
import { classifySentResult, classifyTpStatus, retryDelaySeconds, type Classified } from '../lib/sms-errors.js';
import { getSetting } from '../lib/settings.js';
import { raiseAlert } from './alerts.js';
import { suppressNumber } from './suppression.js';

export const BUDGET_TZ = 'Africa/Mbabane';

export interface LeasedJob {
  attempt_id: string;
  message_id: string;
  phone: string;
  body: string;
  encoding: string;
  segments: number;
  is_test: boolean;
  lease_expires_at: string;
  lease_seconds: number;
}

export type IdleReason =
  | 'KILL_SWITCH'
  | 'GATEWAY_PAUSED'
  | 'EMERGENCY_STOP'
  | 'DAILY_BUDGET_REACHED'
  | 'NO_WORK';

export interface LeaseResult {
  jobs: LeasedJob[];
  idle_reason?: IdleReason;
  next_poll_ms: number;
  send_interval_ms: number;
}

interface GatewayRow {
  id: string;
  name: string;
  status: string;
  is_paused: boolean;
  pause_reason: string | null;
  emergency_stop_at: Date | null;
  send_interval_ms: number;
  batch_limit: number;
  sim_subscription_id: number | null;
}

export async function loadGateway(q: Queryable, id: string, lock = false): Promise<GatewayRow | undefined> {
  const { rows } = await q.query<GatewayRow>(
    `SELECT id, name, status, is_paused, pause_reason, emergency_stop_at, send_interval_ms, batch_limit, sim_subscription_id
       FROM gateways WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0];
}

/** Segments already submitted today plus segments currently in flight on this gateway. */
async function segmentsUsedToday(q: Queryable, gatewayId: string): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `SELECT coalesce((SELECT segments_submitted FROM daily_usage
                       WHERE gateway_id = $1 AND usage_date = (now() AT TIME ZONE $2)::date), 0)
          + coalesce((SELECT sum(segment_count) FROM messages
                       WHERE gateway_id = $1 AND status IN ('LEASED','SENDING')), 0) AS n`,
    [gatewayId, BUDGET_TZ],
  );
  return Number(rows[0]!.n);
}

const READY_SQL = `
SELECT m.id, m.campaign_id, m.segment_count, m.phone_e164, m.is_test
  FROM messages m
  LEFT JOIN campaigns c ON c.id = m.campaign_id
  LEFT JOIN campaign_schedules s ON s.campaign_id = m.campaign_id
 WHERE m.status = 'QUEUED'
   AND m.next_attempt_at <= now()
   AND (
        (m.campaign_id IS NULL AND m.is_test)
     OR (c.status = 'RUNNING'
         AND (c.cooldown_until IS NULL OR c.cooldown_until <= now())
         AND (s.campaign_id IS NULL OR (
              (now() AT TIME ZONE s.timezone)::time >= s.window_start
          AND (now() AT TIME ZONE s.timezone)::time <  s.window_end
          AND extract(isodow FROM now() AT TIME ZONE s.timezone)::int = ANY (s.days_of_week))))
   )
 ORDER BY m.priority, m.next_attempt_at, m.queued_at, m.id
 LIMIT $1
 FOR UPDATE OF m SKIP LOCKED`;

/**
 * Hand up to `max` ready messages to a gateway. Runs in one transaction;
 * concurrent gateways never receive the same message (SKIP LOCKED).
 */
export async function leaseJobs(db: Db, gatewayId: string, requested: number): Promise<LeaseResult> {
  const leaseSeconds = await getSetting(db, 'lease_seconds');
  return withTx(db, async (tx) => {
    const gw = await loadGateway(tx, gatewayId, true);
    if (!gw || gw.status !== 'ACTIVE') throw new Error('gateway not active');
    const idle = (reason: IdleReason, poll = 30_000): LeaseResult => ({
      jobs: [],
      idle_reason: reason,
      next_poll_ms: poll,
      send_interval_ms: gw.send_interval_ms,
    });
    const kill = await getSetting(tx, 'kill_switch');
    if (kill.enabled) return idle('KILL_SWITCH');
    if (gw.emergency_stop_at) return idle('EMERGENCY_STOP');
    if (gw.is_paused) return idle('GATEWAY_PAUSED');

    const dailyBudget = await getSetting(tx, 'daily_segment_budget');
    let budgetLeft = dailyBudget - (await segmentsUsedToday(tx, gatewayId));
    if (budgetLeft <= 0) return idle('DAILY_BUDGET_REACHED', 120_000);

    // Never lease more than can be confirmed before the lease expires.
    const byTime = Math.max(1, Math.floor((leaseSeconds * 1000 * 0.8) / gw.send_interval_ms));
    const limit = Math.max(1, Math.min(requested, gw.batch_limit, byTime));
    const { rows } = await tx.query<{ id: string; campaign_id: string | null; segment_count: number; phone_e164: string; is_test: boolean }>(
      READY_SQL,
      [limit],
    );
    if (!rows.length) return idle('NO_WORK');

    // Drop anything to a suppressed number (cancel it), then apply budgets.
    const supp = await tx.query<{ phone_e164: string }>(
      `SELECT phone_e164 FROM suppressions WHERE lifted_at IS NULL AND phone_e164 = ANY($1::text[])`,
      [rows.map((r) => r.phone_e164)],
    );
    const suppressed = new Set(supp.rows.map((r) => r.phone_e164));
    if (suppressed.size) {
      await tx.query(
        `UPDATE messages SET status = 'CANCELLED', last_error_category = 'SUPPRESSED', last_error_code = 'RECIPIENT_SUPPRESSED', finalized_at = now()
          WHERE id = ANY($1::uuid[])`,
        [rows.filter((r) => suppressed.has(r.phone_e164)).map((r) => r.id)],
      );
    }

    const campaignBudget = new Map<string, number>();
    const cooldownLeft = new Map<string, number>();
    const campaignIds = [...new Set(rows.map((r) => r.campaign_id).filter((x): x is string => Boolean(x)))];
    if (campaignIds.length) {
      const b = await tx.query<{ id: string; left: number | null; cooldown_every: number | null; since: number }>(
        `SELECT c.id,
                c.budget_segments - coalesce((SELECT sum(m.segment_count) FROM messages m
                    WHERE m.campaign_id = c.id AND (m.status IN ('LEASED','SENDING') OR m.submitted_at IS NOT NULL)), 0) AS left,
                s.cooldown_every, c.sent_since_cooldown AS since
           FROM campaigns c LEFT JOIN campaign_schedules s ON s.campaign_id = c.id
          WHERE c.id = ANY($1::uuid[])`,
        [campaignIds],
      );
      for (const r of b.rows) {
        campaignBudget.set(r.id, r.left == null ? Number.POSITIVE_INFINITY : Number(r.left));
        // Cooldown: lease at most (cooldown_every - sent so far) before the rest period.
        if (r.cooldown_every) cooldownLeft.set(r.id, Math.max(0, r.cooldown_every - r.since));
      }
    }

    const chosen: typeof rows = [];
    const exhausted = new Set<string>();
    for (const r of rows) {
      if (suppressed.has(r.phone_e164)) continue;
      if (r.segment_count > budgetLeft) break; // daily budget: stop here, keep order
      if (r.campaign_id) {
        const left = campaignBudget.get(r.campaign_id) ?? Number.POSITIVE_INFINITY;
        if (r.segment_count > left) {
          exhausted.add(r.campaign_id);
          continue;
        }
        const cd = cooldownLeft.get(r.campaign_id);
        if (cd !== undefined) {
          if (cd <= 0) continue;
          cooldownLeft.set(r.campaign_id, cd - 1);
        }
        campaignBudget.set(r.campaign_id, left - r.segment_count);
      }
      budgetLeft -= r.segment_count;
      chosen.push(r);
    }

    // Pause a campaign only once nothing more of it fits (its in-flight messages still finish).
    const chosenCampaigns = new Set(chosen.map((r) => r.campaign_id));
    for (const cid of exhausted) {
      if (chosenCampaigns.has(cid)) continue;
      const upd = await tx.query(
        `UPDATE campaigns SET status = 'PAUSED', pause_reason = 'Campaign segment budget reached', paused_at = now()
          WHERE id = $1 AND status = 'RUNNING'`,
        [cid],
      );
      if (upd.rowCount) {
        await audit(tx, { actorType: 'SYSTEM', action: 'campaign.auto_paused', entityType: 'campaign', entityId: cid, details: { reason: 'BUDGET_REACHED' } });
        await raiseAlert(tx, 'WARNING', 'CAMPAIGN_BUDGET_REACHED', 'A campaign reached its segment budget and was paused. Raise the budget to continue.', 'campaign', cid);
      }
    }
    if (!chosen.length) return idle(budgetLeft <= 0 ? 'DAILY_BUDGET_REACHED' : 'NO_WORK');

    const leaseId = crypto.randomUUID();
    const ids = chosen.map((r) => r.id);
    const upd = await tx.query<LeasedJob & { attempt_no: number }>(
      `WITH upd AS (
         UPDATE messages SET status = 'LEASED', gateway_id = $2, lease_id = $3, leased_at = now(),
                lease_expires_at = now() + make_interval(secs => $4)
          WHERE id = ANY($1::uuid[]) RETURNING id, phone_e164, body, encoding, segment_count, is_test, lease_expires_at
       ), att AS (
         INSERT INTO sms_submission_attempts (message_id, attempt_no, gateway_id, lease_id, sim_subscription_id, parts_total, lease_expires_at)
         SELECT u.id,
                coalesce((SELECT max(a.attempt_no) FROM sms_submission_attempts a WHERE a.message_id = u.id), 0) + 1,
                $2, $3, $5, u.segment_count, u.lease_expires_at
           FROM upd u
         RETURNING id, message_id
       )
       SELECT att.id AS attempt_id, upd.id AS message_id, upd.phone_e164 AS phone, upd.body, upd.encoding,
              upd.segment_count AS segments, upd.is_test, upd.lease_expires_at
         FROM upd JOIN att ON att.message_id = upd.id`,
      [ids, gatewayId, leaseId, leaseSeconds, gw.sim_subscription_id],
    );
    // Preserve queue order in the response.
    const order = new Map(ids.map((id, i) => [id, i]));
    const jobs = upd.rows
      .sort((a, b) => order.get(a.message_id)! - order.get(b.message_id)!)
      .map((j) => ({ ...j, lease_expires_at: new Date(j.lease_expires_at).toISOString(), lease_seconds: leaseSeconds }));
    return { jobs, next_poll_ms: 0, send_interval_ms: gw.send_interval_ms };
  });
}

export type ConfirmDecision =
  | { decision: 'SEND' }
  | { decision: 'DO_NOT_SEND'; reason: string };

/**
 * The phone asks permission immediately before sending one message.
 * Idempotent: asking again for an already-confirmed attempt returns SEND.
 */
export async function confirmSend(db: Db, gatewayId: string, attemptId: string): Promise<ConfirmDecision> {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query<{
      message_id: string;
      outcome: string;
      confirmed_at: Date | null;
      a_lease: string;
      a_gateway: string;
      m_status: string;
      m_lease: string | null;
      lease_expires_at: Date | null;
      phone_e164: string;
      campaign_id: string | null;
      is_test: boolean;
      campaign_status: string | null;
    }>(
      `SELECT a.message_id, a.outcome, a.confirmed_at, a.lease_id AS a_lease, a.gateway_id AS a_gateway,
              m.status AS m_status, m.lease_id AS m_lease, m.lease_expires_at, m.phone_e164, m.campaign_id, m.is_test,
              c.status AS campaign_status
         FROM sms_submission_attempts a
         JOIN messages m ON m.id = a.message_id
         LEFT JOIN campaigns c ON c.id = m.campaign_id
        WHERE a.id = $1
        FOR UPDATE OF a, m`,
      [attemptId],
    );
    const r = rows[0];
    if (!r || r.a_gateway !== gatewayId) return { decision: 'DO_NOT_SEND', reason: 'UNKNOWN_ATTEMPT' };
    if (r.confirmed_at && r.m_status === 'SENDING' && r.m_lease === r.a_lease) return { decision: 'SEND' };
    if (r.outcome !== 'PENDING' || r.m_status !== 'LEASED' || r.m_lease !== r.a_lease) {
      return { decision: 'DO_NOT_SEND', reason: 'LEASE_NO_LONGER_VALID' };
    }

    const notSend = async (reason: string, messageStatus: 'QUEUED' | 'CANCELLED', category?: string) => {
      await tx.query(`UPDATE sms_submission_attempts SET outcome = 'NOT_SENT', detail = $2, reported_at = now() WHERE id = $1`, [attemptId, reason]);
      await tx.query(
        `UPDATE messages SET status = $2, lease_id = NULL, leased_at = NULL, lease_expires_at = NULL,
                gateway_id = CASE WHEN $2 = 'QUEUED' THEN NULL ELSE gateway_id END,
                last_error_category = coalesce($3, last_error_category), last_error_code = CASE WHEN $3 IS NULL THEN last_error_code ELSE $4 END,
                finalized_at = CASE WHEN $2 = 'CANCELLED' THEN now() ELSE NULL END
          WHERE id = $1`,
        [r.message_id, messageStatus, category ?? null, reason],
      );
      return { decision: 'DO_NOT_SEND' as const, reason };
    };

    if (!r.lease_expires_at || r.lease_expires_at.getTime() <= Date.now()) return notSend('LEASE_EXPIRED', 'QUEUED');
    const kill = await getSetting(tx, 'kill_switch');
    if (kill.enabled) return notSend('KILL_SWITCH', 'QUEUED');
    const gw = await loadGateway(tx, gatewayId);
    if (!gw || gw.status !== 'ACTIVE') return notSend('GATEWAY_INACTIVE', 'QUEUED');
    if (gw.emergency_stop_at) return notSend('EMERGENCY_STOP', 'QUEUED');
    if (gw.is_paused) return notSend('GATEWAY_PAUSED', 'QUEUED');
    const supp = await tx.query('SELECT 1 FROM suppressions WHERE phone_e164 = $1 AND lifted_at IS NULL', [r.phone_e164]);
    if (supp.rowCount) return notSend('RECIPIENT_SUPPRESSED', 'CANCELLED', 'SUPPRESSED');
    if (r.campaign_id) {
      if (r.campaign_status === 'CANCELLED') return notSend('CAMPAIGN_CANCELLED', 'CANCELLED', 'CANCELLED');
      if (r.campaign_status !== 'RUNNING') return notSend(`CAMPAIGN_${r.campaign_status}`, 'QUEUED');
    }

    await tx.query(`UPDATE sms_submission_attempts SET confirmed_at = now() WHERE id = $1`, [attemptId]);
    await tx.query(`UPDATE messages SET status = 'SENDING', attempt_count = attempt_count + 1 WHERE id = $1`, [r.message_id]);
    return { decision: 'SEND' };
  });
}

// ---------------------------------------------------------------------------
// Report ingestion
// ---------------------------------------------------------------------------

export type GatewayEvent =
  | { id: string; type: 'PART_SENT'; attempt_id: string; part_index: number; parts_total: number; result_code: number; at?: string }
  | { id: string; type: 'SEND_ERROR'; attempt_id: string; app_code: string; detail?: string; at?: string }
  | { id: string; type: 'SUBMIT_UNKNOWN'; attempt_id: string; app_code: string; at?: string }
  | { id: string; type: 'NOT_SENT'; attempt_id: string; reason: string; at?: string }
  | { id: string; type: 'DELIVERY'; attempt_id: string; part_index: number; tp_status: number; at?: string }
  | { id: string; type: 'INBOUND'; from: string; body: string; at?: string }
  | { id: string; type: 'DIAGNOSTIC_SMS'; to: string; result_code: number | null; app_code?: string; at?: string };

export interface EventAck {
  id: string;
  ok: boolean;
  note?: string;
}

interface AttemptCtx {
  attempt_id: string;
  message_id: string;
  attempt_no: number;
  outcome: string;
  confirmed_at: Date | null;
  parts_total: number;
  gateway_id: string;
  m_status: string;
  m_lease: string | null;
  a_lease: string;
  attempt_count: number;
  max_attempts: number;
  campaign_id: string | null;
  campaign_status: string | null;
  phone_e164: string | null;
  segment_count: number;
  is_test: boolean;
  delivery_state: string;
}

async function lockAttempt(tx: Tx, gatewayId: string, attemptId: string): Promise<AttemptCtx | undefined> {
  const { rows } = await tx.query<AttemptCtx>(
    `SELECT a.id AS attempt_id, a.message_id, a.attempt_no, a.outcome, a.confirmed_at, a.parts_total, a.gateway_id,
            a.lease_id AS a_lease, m.status AS m_status, m.lease_id AS m_lease, m.attempt_count, m.max_attempts,
            m.campaign_id, c.status AS campaign_status, m.phone_e164, m.segment_count, m.is_test, m.delivery_state
       FROM sms_submission_attempts a JOIN messages m ON m.id = a.message_id
       LEFT JOIN campaigns c ON c.id = m.campaign_id
      WHERE a.id = $1 FOR UPDATE OF a, m`,
    [attemptId],
  );
  const r = rows[0];
  if (!r || r.gateway_id !== gatewayId) return undefined;
  return r;
}

/** Is this attempt still the one that decides the message's fate? */
function isCurrent(a: AttemptCtx): boolean {
  if (a.m_status === 'SENDING' || a.m_status === 'LEASED') return a.m_lease === a.a_lease;
  // UNKNOWN (or a lease that already expired) can be resolved by the attempt that caused it.
  return a.m_status === 'UNKNOWN' || a.m_status === 'QUEUED';
}

export async function applyEvents(db: Db, gateway: { id: string; name: string }, events: GatewayEvent[]): Promise<EventAck[]> {
  const acks: EventAck[] = [];
  for (const ev of events) {
    try {
      const note = await withTx(db, (tx) => applyEvent(tx, gateway, ev));
      acks.push({ id: ev.id, ok: true, note: note ?? undefined });
    } catch (err) {
      acks.push({ id: ev.id, ok: false, note: (err as Error).message.slice(0, 200) });
    }
  }
  return acks;
}

async function applyEvent(tx: Tx, gateway: { id: string; name: string }, ev: GatewayEvent): Promise<string | void> {
  switch (ev.type) {
    case 'INBOUND':
      return handleInbound(tx, gateway, ev.from, ev.body);
    case 'DIAGNOSTIC_SMS':
      await audit(tx, {
        actorType: 'GATEWAY',
        actorId: gateway.id,
        action: 'gateway.diagnostic_sms',
        entityType: 'gateway',
        entityId: gateway.id,
        details: { to: ev.to.slice(0, 7) + '…', result_code: ev.result_code, app_code: ev.app_code ?? null },
      });
      return;
  }

  const a = await lockAttempt(tx, gateway.id, ev.attempt_id);
  if (!a) return 'unknown attempt (ignored)';

  switch (ev.type) {
    case 'PART_SENT': {
      const ins = await tx.query(
        `INSERT INTO sms_part_results (attempt_id, part_index, result_code, ok) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [a.attempt_id, ev.part_index, ev.result_code, ev.result_code === -1],
      );
      if (!ins.rowCount) return 'duplicate';
      const partsTotal = Math.max(1, ev.parts_total);
      const { rows } = await tx.query<{ ok: number; failed: number; first_fail: number | null }>(
        `SELECT count(*) FILTER (WHERE ok)::int AS ok, count(*) FILTER (WHERE NOT ok)::int AS failed,
                (array_agg(result_code ORDER BY part_index) FILTER (WHERE NOT ok))[1] AS first_fail
           FROM sms_part_results WHERE attempt_id = $1`,
        [a.attempt_id],
      );
      const { ok, failed, first_fail } = rows[0]!;
      await tx.query(`UPDATE sms_submission_attempts SET parts_total = $2, parts_ok = $3, parts_failed = $4 WHERE id = $1`, [
        a.attempt_id,
        partsTotal,
        ok,
        failed,
      ]);
      if (a.outcome !== 'PENDING' && a.outcome !== 'UNKNOWN') return 'attempt already final';
      if (failed > 0) return finalizeFailure(tx, a, classifySentResult(first_fail), gateway, ev.at);
      if (ok >= partsTotal) return finalizeSubmitted(tx, a, partsTotal, ev.at);
      return;
    }
    case 'SEND_ERROR': {
      if (a.outcome !== 'PENDING') return 'attempt already final';
      return finalizeFailure(tx, a, classifySentResult(null, ev.app_code), gateway, ev.at, ev.detail);
    }
    case 'SUBMIT_UNKNOWN': {
      if (a.outcome !== 'PENDING') return 'attempt already final';
      const c = classifySentResult(null, ev.app_code);
      await tx.query(`UPDATE sms_submission_attempts SET outcome = 'UNKNOWN', error_code = $2, error_category = 'DELIVERY_UNKNOWN', reported_at = now() WHERE id = $1`, [
        a.attempt_id,
        c.code,
      ]);
      if (isCurrent(a)) {
        await markUnknown(tx, a.message_id, c.code);
        if (a.campaign_id) await checkFailureRatio(tx, a.campaign_id);
      }
      return;
    }
    case 'NOT_SENT': {
      if (a.outcome !== 'PENDING' && a.outcome !== 'UNKNOWN') return 'attempt already final';
      await tx.query(`UPDATE sms_submission_attempts SET outcome = 'NOT_SENT', detail = $2, reported_at = now() WHERE id = $1`, [a.attempt_id, ev.reason.slice(0, 100)]);
      if (!isCurrent(a)) return;
      if (['QUEUED'].includes(a.m_status)) return; // sweeper already requeued it
      const cancelled = a.campaign_status === 'CANCELLED';
      await tx.query(
        `UPDATE messages SET status = $2, lease_id = NULL, leased_at = NULL, lease_expires_at = NULL,
                gateway_id = CASE WHEN $2 = 'QUEUED' THEN NULL ELSE gateway_id END,
                attempt_count = greatest(0, attempt_count - $3::int),
                finalized_at = CASE WHEN $2 = 'CANCELLED' THEN now() ELSE NULL END,
                last_error_category = CASE WHEN $2 = 'CANCELLED' THEN 'CANCELLED' ELSE last_error_category END
          WHERE id = $1`,
        [a.message_id, cancelled ? 'CANCELLED' : 'QUEUED', a.confirmed_at ? 1 : 0],
      );
      return;
    }
    case 'DELIVERY':
      return handleDelivery(tx, a, ev.part_index, ev.tp_status, ev.at);
  }
}

async function markUnknown(tx: Tx, messageId: string, code: string) {
  await tx.query(
    `UPDATE messages SET status = 'UNKNOWN', lease_id = NULL, leased_at = NULL, lease_expires_at = NULL,
            last_error_category = 'DELIVERY_UNKNOWN', last_error_code = $2
      WHERE id = $1 AND status IN ('LEASED','SENDING','UNKNOWN')`,
    [messageId, code],
  );
}

async function finalizeSubmitted(tx: Tx, a: AttemptCtx, partsTotal: number, at?: string) {
  await tx.query(
    `UPDATE sms_submission_attempts SET outcome = 'SUBMITTED', reported_at = now(), device_sent_at = $2 WHERE id = $1`,
    [a.attempt_id, safeDate(at)],
  );
  if (!isCurrent(a)) return;
  await tx.query(
    `UPDATE messages SET status = 'SUBMITTED', submitted_at = now(), delivery_state = 'AWAITING_REPORT',
            lease_id = NULL, leased_at = NULL, lease_expires_at = NULL, gateway_id = $2,
            attempt_count = greatest(attempt_count, 1),
            last_error_code = NULL, last_error_category = NULL, dead_lettered_at = NULL
      WHERE id = $1`,
    [a.message_id, a.gateway_id],
  );
  await tx.query(
    `INSERT INTO daily_usage (usage_date, gateway_id, segments_submitted, messages_submitted)
     VALUES ((now() AT TIME ZONE $3)::date, $1, $2, 1)
     ON CONFLICT (usage_date, gateway_id) DO UPDATE SET
       segments_submitted = daily_usage.segments_submitted + EXCLUDED.segments_submitted,
       messages_submitted = daily_usage.messages_submitted + 1`,
    [a.gateway_id, partsTotal, BUDGET_TZ],
  );
  if (a.campaign_id) {
    // Cooldown bookkeeping: after every N messages, rest for M seconds.
    await tx.query(
      `UPDATE campaigns c SET
         sent_since_cooldown = CASE WHEN s.cooldown_every IS NOT NULL AND c.sent_since_cooldown + 1 >= s.cooldown_every THEN 0 ELSE c.sent_since_cooldown + 1 END,
         cooldown_until = CASE WHEN s.cooldown_every IS NOT NULL AND c.sent_since_cooldown + 1 >= s.cooldown_every
                               THEN now() + make_interval(secs => s.cooldown_seconds) ELSE c.cooldown_until END
         FROM campaign_schedules s WHERE c.id = $1 AND s.campaign_id = c.id`,
      [a.campaign_id],
    );
  }
}

async function finalizeFailure(tx: Tx, a: AttemptCtx, c: Classified, gateway: { id: string; name: string }, at?: string, detail?: string) {
  await tx.query(
    `UPDATE sms_submission_attempts SET outcome = 'FAILED', error_code = $2, error_category = $3, reported_at = now(),
            device_sent_at = $4, android_result_code = $5, detail = $6 WHERE id = $1`,
    [a.attempt_id, c.code, c.category, safeDate(at), /^\d+$/.test(c.code) ? Number(c.code) : null, detail?.slice(0, 300) ?? null],
  );
  if (!isCurrent(a)) return;

  if (c.retry === 'GATEWAY') {
    // The phone, not the recipient, is the problem: give the message back without
    // spending one of its attempts, and stop this gateway until someone looks.
    await tx.query(
      `UPDATE messages SET status = 'QUEUED', lease_id = NULL, leased_at = NULL, lease_expires_at = NULL, gateway_id = NULL,
              attempt_count = greatest(0, attempt_count - 1), next_attempt_at = now() + interval '60 seconds',
              last_error_code = $2, last_error_category = $3
        WHERE id = $1`,
      [a.message_id, c.code, c.category],
    );
    await pauseGateway(tx, gateway, `${c.code}: ${c.description}`);
    return;
  }

  const policy = await getSetting(tx, 'retry_policy');
  const live = !a.campaign_id || ['RUNNING', 'PAUSED', 'SCHEDULED', 'APPROVED'].includes(a.campaign_status ?? '');
  const triesUsed = Math.max(1, a.attempt_count);
  if (c.retry === 'TRANSIENT' && triesUsed < a.max_attempts && live && !a.is_test) {
    const delay = retryDelaySeconds(triesUsed, policy.base_seconds, policy.max_seconds);
    await tx.query(
      `UPDATE messages SET status = 'QUEUED', lease_id = NULL, leased_at = NULL, lease_expires_at = NULL, gateway_id = NULL,
              next_attempt_at = now() + make_interval(secs => $4), last_error_code = $2, last_error_category = $3
        WHERE id = $1`,
      [a.message_id, c.code, c.category, delay],
    );
    await tx.query(`INSERT INTO retry_jobs (message_id, kind, reason, scheduled_for) VALUES ($1, 'AUTO', $2, now() + make_interval(secs => $3))`, [
      a.message_id,
      `${c.code} (attempt ${triesUsed} of ${a.max_attempts})`,
      delay,
    ]);
  } else {
    const exhausted = c.retry === 'TRANSIENT';
    await tx.query(
      `UPDATE messages SET status = 'FAILED', lease_id = NULL, leased_at = NULL, lease_expires_at = NULL,
              last_error_code = $2, last_error_category = $3, finalized_at = now(),
              dead_lettered_at = CASE WHEN $4 THEN now() ELSE NULL END
        WHERE id = $1`,
      [a.message_id, c.code, c.category, exhausted],
    );
  }
  await checkGatewayFailureStreak(tx, gateway);
  if (a.campaign_id) await checkFailureRatio(tx, a.campaign_id);
}

async function handleDelivery(tx: Tx, a: AttemptCtx, partIndex: number, tp: number, at?: string) {
  const status = classifyTpStatus(tp);
  await tx.query(
    `INSERT INTO delivery_reports (message_id, attempt_id, gateway_id, part_index, status, tp_status, device_received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (attempt_id, part_index) DO UPDATE SET status = EXCLUDED.status, tp_status = EXCLUDED.tp_status, received_at = now()
       WHERE delivery_reports.status = 'PENDING'`,
    [a.message_id, a.attempt_id, a.gateway_id, partIndex, status, tp, safeDate(at)],
  );
  // A delivery report proves the attempt was submitted, even if we had marked it UNKNOWN.
  if (a.outcome === 'PENDING' || a.outcome === 'UNKNOWN') {
    await finalizeSubmitted(tx, { ...a, outcome: 'UNKNOWN' }, a.parts_total, at);
    a.m_status = 'SUBMITTED';
  }
  const { rows } = await tx.query<{ delivered: number; failed: number }>(
    `SELECT count(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered, count(*) FILTER (WHERE status = 'FAILED')::int AS failed
       FROM delivery_reports WHERE attempt_id = $1`,
    [a.attempt_id],
  );
  const { delivered, failed } = rows[0]!;
  if (failed > 0) {
    await tx.query(
      `UPDATE messages SET status = 'FAILED', delivery_state = 'FAILED', last_error_category = 'DELIVERY_FAILURE',
              last_error_code = $2, finalized_at = now()
        WHERE id = $1 AND status IN ('SUBMITTED','DELIVERED')`,
      [a.message_id, `TP_STATUS_0x${tp.toString(16).padStart(2, '0')}`],
    );
  } else if (delivered >= a.parts_total) {
    await tx.query(
      `UPDATE messages SET status = 'DELIVERED', delivery_state = 'CONFIRMED', delivered_at = now(), finalized_at = now()
        WHERE id = $1 AND status = 'SUBMITTED'`,
      [a.message_id],
    );
  }
}

async function handleInbound(tx: Tx, gateway: { id: string; name: string }, from: string, body: string): Promise<string> {
  const keywords = (await getSetting(tx, 'opt_out_keywords')).map((k) => k.toUpperCase());
  const text = body.trim().toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ');
  const first = text.split(' ')[0] ?? '';
  const isOptOut = keywords.includes(text) || keywords.includes(first);
  // The message content itself is never stored.
  if (!isOptOut) return 'not an opt-out keyword (content discarded)';
  const { normalizePhone } = await import('../lib/phone.js');
  const n = normalizePhone(from, await getSetting(tx, 'default_country'), { allowNonMobile: true });
  if (!n.ok) return 'unparseable sender';
  const r = await suppressNumber(tx, n.e164, 'OPT_OUT', `SMS reply "${first}" via gateway ${gateway.name}`, null, {
    actorType: 'GATEWAY',
    actorId: gateway.id,
  });
  if (!r.alreadySuppressed) {
    await raiseAlert(tx, 'INFO', 'INBOUND_OPT_OUT', `A recipient opted out by SMS reply (${r.cancelledMessages} queued message(s) cancelled).`, 'suppression', r.suppressionId);
  }
  return r.alreadySuppressed ? 'already suppressed' : 'opted out';
}

async function pauseGateway(tx: Tx, gateway: { id: string; name: string }, reason: string) {
  const r = await tx.query(`UPDATE gateways SET is_paused = true, pause_reason = $2 WHERE id = $1 AND NOT is_paused`, [gateway.id, reason.slice(0, 300)]);
  if (r.rowCount) {
    await audit(tx, { actorType: 'SYSTEM', action: 'gateway.auto_paused', entityType: 'gateway', entityId: gateway.id, details: { reason } });
    await raiseAlert(tx, 'CRITICAL', 'GATEWAY_PAUSED', `Gateway "${gateway.name}" was paused automatically: ${reason}`, 'gateway', gateway.id);
  }
}

/** Ten failures in a row on one phone usually means no signal or a blocked SIM. */
async function checkGatewayFailureStreak(tx: Tx, gateway: { id: string; name: string }) {
  const { rows } = await tx.query<{ outcome: string }>(
    `SELECT outcome FROM sms_submission_attempts
      WHERE gateway_id = $1 AND reported_at IS NOT NULL AND outcome IN ('SUBMITTED','FAILED')
      ORDER BY reported_at DESC LIMIT 10`,
    [gateway.id],
  );
  if (rows.length === 10 && rows.every((r) => r.outcome === 'FAILED')) {
    await pauseGateway(tx, gateway, '10 consecutive send failures (check signal, airtime and whether the carrier is blocking the SIM)');
  }
}

/**
 * Auto-pause a campaign when too many recent outcomes are failures. Called after
 * each failure (a success can only lower the ratio). Uses the reported_at index,
 * so the cost does not grow with campaign size.
 */
export async function checkFailureRatio(tx: Tx, campaignId: string) {
  const { rows } = await tx.query<{ win: number; ratio: number; n: number; bad: number; status: string }>(
    `WITH c AS (SELECT failure_window_size AS win, failure_pause_ratio AS ratio, status FROM campaigns WHERE id = $1),
          recent AS (
            SELECT a.outcome FROM sms_submission_attempts a JOIN messages m ON m.id = a.message_id
             WHERE m.campaign_id = $1 AND a.outcome IN ('SUBMITTED','FAILED','UNKNOWN')
               AND a.reported_at > now() - interval '6 hours'
               AND coalesce(a.error_category, '') NOT IN ('RATE_LIMITED','MISSING_PERMISSION','SIM_UNAVAILABLE')
             ORDER BY a.reported_at DESC LIMIT (SELECT win FROM c))
     SELECT c.win, c.ratio, c.status, (SELECT count(*)::int FROM recent) AS n,
            (SELECT count(*)::int FROM recent WHERE outcome <> 'SUBMITTED') AS bad FROM c`,
    [campaignId],
  );
  const r = rows[0];
  if (!r || r.status !== 'RUNNING' || r.n < r.win) return;
  if (r.bad / r.n >= r.ratio) {
    const reason = `Auto-paused: ${r.bad} of the last ${r.n} attempts failed or are unknown (threshold ${Math.round(r.ratio * 100)}%)`;
    await tx.query(`UPDATE campaigns SET status = 'PAUSED', pause_reason = $2, paused_at = now() WHERE id = $1 AND status = 'RUNNING'`, [campaignId, reason]);
    await audit(tx, { actorType: 'SYSTEM', action: 'campaign.auto_paused', entityType: 'campaign', entityId: campaignId, details: { reason } });
    await raiseAlert(tx, 'CRITICAL', 'CAMPAIGN_AUTO_PAUSED', reason, 'campaign', campaignId);
  }
}

function safeDate(at?: string): Date | null {
  if (!at) return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Sweeper (run periodically by the worker)
// ---------------------------------------------------------------------------

export interface SweepResult {
  requeued: number;
  unknown: number;
  cancelled: number;
}

export async function sweepLeases(db: Db): Promise<SweepResult> {
  const grace = await getSetting(db, 'sending_confirm_grace_seconds');
  return withTx(db, async (tx) => {
    // LEASED but never confirmed: provably unsent.
    const expired = await tx.query<{ id: string; lease_id: string; campaign_status: string | null }>(
      `SELECT m.id, m.lease_id, c.status AS campaign_status FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id
        WHERE m.status = 'LEASED' AND m.lease_expires_at < now() FOR UPDATE OF m SKIP LOCKED`,
    );
    let cancelled = 0;
    for (const m of expired.rows) {
      await tx.query(`UPDATE sms_submission_attempts SET outcome = 'NOT_SENT', detail = 'LEASE_EXPIRED', reported_at = now()
                       WHERE message_id = $1 AND lease_id = $2 AND outcome = 'PENDING'`, [m.id, m.lease_id]);
      const cancel = m.campaign_status === 'CANCELLED';
      if (cancel) cancelled++;
      await tx.query(
        `UPDATE messages SET status = $2, lease_id = NULL, leased_at = NULL, lease_expires_at = NULL,
                gateway_id = CASE WHEN $2 = 'QUEUED' THEN NULL ELSE gateway_id END,
                finalized_at = CASE WHEN $2 = 'CANCELLED' THEN now() ELSE NULL END,
                last_error_category = CASE WHEN $2 = 'CANCELLED' THEN 'CANCELLED' ELSE last_error_category END
          WHERE id = $1`,
        [m.id, cancel ? 'CANCELLED' : 'QUEUED'],
      );
    }
    // Confirmed (SENDING) but no result long after the lease ended: we cannot know.
    const stuck = await tx.query<{ id: string; lease_id: string }>(
      `SELECT id, lease_id FROM messages WHERE status = 'SENDING' AND lease_expires_at < now() - make_interval(secs => $1)
        FOR UPDATE SKIP LOCKED`,
      [grace],
    );
    for (const m of stuck.rows) {
      await tx.query(`UPDATE sms_submission_attempts SET outcome = 'UNKNOWN', error_code = 'NO_RESULT_REPORTED', error_category = 'DELIVERY_UNKNOWN', reported_at = now()
                       WHERE message_id = $1 AND lease_id = $2 AND outcome = 'PENDING'`, [m.id, m.lease_id]);
      await markUnknown(tx, m.id, 'NO_RESULT_REPORTED');
    }
    if (stuck.rows.length) {
      await raiseAlert(tx, 'WARNING', 'MESSAGES_UNKNOWN', `${stuck.rows.length} message(s) have an unknown outcome and need reconciliation before any resend.`);
    }
    return { requeued: expired.rows.length - cancelled, unknown: stuck.rows.length, cancelled };
  });
}

/** Phone asked to give back jobs it will not send (pause, emergency stop, shutdown). */
export async function releaseAttempts(db: Db, gateway: { id: string; name: string }, attemptIds: string[], reason: string): Promise<number> {
  const events: GatewayEvent[] = attemptIds.map((id) => ({ id, type: 'NOT_SENT', attempt_id: id, reason }));
  const acks = await applyEvents(db, gateway, events);
  return acks.filter((a) => a.ok && !a.note).length;
}
