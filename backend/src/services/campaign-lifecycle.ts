import type { Tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { AppError, conflict, notFound, unprocessable } from '../lib/errors.js';
import { normalizePhone } from '../lib/phone.js';
import { analyzeSms } from '../lib/segments.js';
import { getSetting } from '../lib/settings.js';
import { renderTemplate } from '../lib/template.js';
import { evaluateRecipients, loadCandidates, summarize } from './eligibility.js';

type Actor = { actorType: 'ADMIN'; actorId: string | null; ip?: string | null };

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  body_template: string;
  consent_purpose: string;
  max_recipients: number;
  budget_segments: number | null;
  created_by: string;
  submitted_by: string | null;
  test_message_id: string | null;
}

async function lockCampaign(tx: Tx, id: string): Promise<CampaignRow> {
  const { rows } = await tx.query<CampaignRow>(
    `SELECT id, name, status, body_template, consent_purpose, max_recipients, budget_segments, created_by, submitted_by, test_message_id
       FROM campaigns WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!rows[0]) throw notFound('Campaign');
  return rows[0];
}

async function groupIds(tx: Tx, id: string): Promise<string[]> {
  const { rows } = await tx.query<{ group_id: string }>('SELECT group_id FROM campaign_groups WHERE campaign_id = $1', [id]);
  return rows.map((r) => r.group_id);
}

function requireStatus(c: CampaignRow, allowed: string[], action: string) {
  if (!allowed.includes(c.status)) {
    throw conflict('INVALID_STATE', `Cannot ${action} a campaign that is ${c.status} (allowed: ${allowed.join(', ')})`);
  }
}

/** Send the campaign text (personalised with the first eligible recipient's data) to an authorised test number. */
export async function sendTestMessage(tx: Tx, campaignId: string, phoneInput: string, actor: Actor) {
  const c = await lockCampaign(tx, campaignId);
  requireStatus(c, ['DRAFT', 'PENDING_APPROVAL'], 'test');
  const allowed = await getSetting(tx, 'test_numbers');
  const n = normalizePhone(phoneInput, await getSetting(tx, 'default_country'));
  if (!n.ok) throw unprocessable('INVALID_PHONE', n.message);
  if (!allowed.includes(n.e164)) {
    throw new AppError(403, 'NOT_A_TEST_NUMBER', 'Test messages can only go to numbers listed in Settings → Authorised test numbers');
  }
  const candidates = await loadCandidates(tx, await groupIds(tx, campaignId), c.consent_purpose);
  const first = evaluateRecipients(candidates, c.body_template, 1).find((e) => e.decision === 'INCLUDED');
  const sample = first ? candidates.find((x) => x.contact_id === first.contactId)! : { first_name: 'Test', last_name: 'Recipient', reference_no: 'REF-TEST' };
  const text = renderTemplate(c.body_template, sample).text;
  const seg = analyzeSms(text);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO messages (is_test, phone_e164, body, encoding, segment_count, priority, max_attempts, created_by)
     VALUES (true, $1, $2, $3, $4, 0, 1, $5) RETURNING id`,
    [n.e164, text, seg.encoding, seg.segments, actor.actorId],
  );
  await tx.query('UPDATE campaigns SET test_message_id = $2 WHERE id = $1', [campaignId, rows[0]!.id]);
  await audit(tx, { ...actor, action: 'campaign.test_queued', entityType: 'campaign', entityId: campaignId, details: { message_id: rows[0]!.id, to: n.e164.slice(0, 7) + '…' } });
  return { message_id: rows[0]!.id, text, encoding: seg.encoding, segments: seg.segments };
}

export async function submitForApproval(tx: Tx, campaignId: string, actor: Actor) {
  const c = await lockCampaign(tx, campaignId);
  requireStatus(c, ['DRAFT'], 'submit');
  const summary = summarize(evaluateRecipients(await loadCandidates(tx, await groupIds(tx, campaignId), c.consent_purpose), c.body_template, c.max_recipients));
  if (summary.included === 0) throw unprocessable('NO_ELIGIBLE_RECIPIENTS', 'No eligible recipients: check consent, opt-outs and number validity');
  await tx.query(
    `UPDATE campaigns SET status = 'PENDING_APPROVAL', submitted_by = $2, segments_estimated = $3, recipients_included = $4,
            recipients_excluded = $5 WHERE id = $1`,
    [campaignId, actor.actorId, summary.segmentsTotal, summary.included, summary.candidates - summary.included],
  );
  await audit(tx, { ...actor, action: 'campaign.submitted', entityType: 'campaign', entityId: campaignId, details: { summary } });
  return summary;
}

export async function rejectToDraft(tx: Tx, campaignId: string, note: string, actor: Actor) {
  const c = await lockCampaign(tx, campaignId);
  requireStatus(c, ['PENDING_APPROVAL'], 'return to draft');
  await tx.query(`UPDATE campaigns SET status = 'DRAFT', submitted_by = NULL WHERE id = $1`, [campaignId]);
  await audit(tx, { ...actor, action: 'campaign.returned_to_draft', entityType: 'campaign', entityId: campaignId, details: { note } });
}

/**
 * Approve: re-run every check inside this transaction, freeze the recipient list
 * and create one QUEUED message per included recipient. Idempotent by
 * construction: campaign_recipients and messages have unique constraints, and the
 * campaign row lock plus the status check stop a second approval.
 */
export async function approve(tx: Tx, campaignId: string, actor: Actor, opts: { allowSeed: boolean; confirmName: string }) {
  const c = await lockCampaign(tx, campaignId);
  requireStatus(c, ['PENDING_APPROVAL'], 'approve');
  if (opts.confirmName.trim() !== c.name.trim()) {
    throw unprocessable('CONFIRMATION_MISMATCH', 'Type the campaign name exactly to confirm sending');
  }
  if ((await getSetting(tx, 'require_separate_approver')) && (actor.actorId === c.submitted_by || actor.actorId === c.created_by)) {
    throw new AppError(403, 'SEPARATE_APPROVER_REQUIRED', 'A different administrator must approve this campaign');
  }
  if (await getSetting(tx, 'require_test_before_approval')) {
    const t = c.test_message_id
      ? (await tx.query<{ status: string }>('SELECT status FROM messages WHERE id = $1', [c.test_message_id])).rows[0]
      : undefined;
    if (!t || !['SUBMITTED', 'DELIVERED'].includes(t.status)) {
      throw unprocessable('TEST_REQUIRED', 'Send a test message to an authorised number and wait until it is submitted before approving');
    }
  }
  const evaluated = evaluateRecipients(await loadCandidates(tx, await groupIds(tx, campaignId), c.consent_purpose), c.body_template, c.max_recipients);
  const summary = summarize(evaluated);
  if (summary.included === 0) throw unprocessable('NO_ELIGIBLE_RECIPIENTS', 'No eligible recipients');
  if (c.budget_segments && summary.segmentsTotal > c.budget_segments) {
    throw unprocessable('OVER_BUDGET', `Needs ${summary.segmentsTotal} segments but the campaign budget is ${c.budget_segments}`);
  }
  if (!opts.allowSeed) {
    const seed = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM contacts WHERE id = ANY($1::uuid[]) AND 'SEED_DATA' = ANY(tags)`,
      [evaluated.filter((e) => e.decision === 'INCLUDED').map((e) => e.contactId)],
    );
    if (seed.rows[0]!.n > 0) {
      throw unprocessable('SEED_DATA_PRESENT', `${seed.rows[0]!.n} recipient(s) are generated demo contacts (tag SEED_DATA). Remove them; they may be real people's numbers.`);
    }
  }

  // Freeze the decision for every candidate (bulk insert via unnest).
  const cols = {
    contact: [] as string[],
    phone: [] as (string | null)[],
    decision: [] as string[],
    reason: [] as (string | null)[],
    body: [] as (string | null)[],
    enc: [] as (string | null)[],
    seg: [] as (number | null)[],
  };
  for (const e of evaluated) {
    cols.contact.push(e.contactId);
    cols.phone.push(e.decision === 'INCLUDED' ? e.phoneE164 : e.phoneE164);
    cols.decision.push(e.decision);
    cols.reason.push(e.exclusionReason ?? null);
    cols.body.push(e.renderedBody ?? null);
    cols.enc.push(e.encoding ?? null);
    cols.seg.push(e.segments ?? null);
  }
  await tx.query('DELETE FROM campaign_recipients WHERE campaign_id = $1', [campaignId]);
  await tx.query(
    `INSERT INTO campaign_recipients (campaign_id, contact_id, phone_e164, decision, exclusion_reason, rendered_body, encoding, segment_count)
     SELECT $1, * FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::smallint[])`,
    [campaignId, cols.contact, cols.phone, cols.decision, cols.reason, cols.body, cols.enc, cols.seg],
  );
  const msgs = await tx.query(
    `INSERT INTO messages (campaign_id, campaign_recipient_id, contact_id, phone_e164, body, encoding, segment_count, created_by)
     SELECT campaign_id, id, contact_id, phone_e164, rendered_body, encoding, segment_count, $2
       FROM campaign_recipients WHERE campaign_id = $1 AND decision = 'INCLUDED'`,
    [campaignId, actor.actorId],
  );
  const sched = await tx.query<{ start_at: Date | null }>('SELECT start_at FROM campaign_schedules WHERE campaign_id = $1', [campaignId]);
  const startAt = sched.rows[0]?.start_at;
  const status = startAt && startAt.getTime() > Date.now() ? 'SCHEDULED' : 'APPROVED';
  await tx.query(
    `UPDATE campaigns SET status = $2, approved_by = $3, approved_at = now(), segments_estimated = $4,
            recipients_included = $5, recipients_excluded = $6 WHERE id = $1`,
    [campaignId, status, actor.actorId, summary.segmentsTotal, summary.included, summary.candidates - summary.included],
  );
  await audit(tx, { ...actor, action: 'campaign.approved', entityType: 'campaign', entityId: campaignId, details: { queued: msgs.rowCount, summary, status } });
  return { status, queued: msgs.rowCount ?? 0, summary };
}

export async function start(tx: Tx, campaignId: string, actor: Actor) {
  const c = await lockCampaign(tx, campaignId);
  requireStatus(c, ['APPROVED', 'SCHEDULED'], 'start');
  await tx.query(`UPDATE campaigns SET status = 'RUNNING', started_at = coalesce(started_at, now()), pause_reason = NULL WHERE id = $1`, [campaignId]);
  await audit(tx, { ...actor, action: 'campaign.started', entityType: 'campaign', entityId: campaignId });
}

export async function pause(tx: Tx, campaignId: string, reason: string, actor: Actor) {
  const c = await lockCampaign(tx, campaignId);
  requireStatus(c, ['RUNNING', 'SCHEDULED', 'APPROVED'], 'pause');
  await tx.query(`UPDATE campaigns SET status = 'PAUSED', pause_reason = $2, paused_by = $3, paused_at = now() WHERE id = $1`, [campaignId, reason, actor.actorId]);
  await audit(tx, { ...actor, action: 'campaign.paused', entityType: 'campaign', entityId: campaignId, details: { reason } });
}

export async function resume(tx: Tx, campaignId: string, actor: Actor) {
  const c = await lockCampaign(tx, campaignId);
  requireStatus(c, ['PAUSED'], 'resume');
  const sched = await tx.query<{ start_at: Date | null }>('SELECT start_at FROM campaign_schedules WHERE campaign_id = $1', [campaignId]);
  const future = sched.rows[0]?.start_at && sched.rows[0].start_at.getTime() > Date.now();
  await tx.query(
    `UPDATE campaigns SET status = $2, pause_reason = NULL, paused_by = NULL, paused_at = NULL,
            started_at = CASE WHEN $2 = 'RUNNING' THEN coalesce(started_at, now()) ELSE started_at END WHERE id = $1`,
    [campaignId, future ? 'SCHEDULED' : 'RUNNING'],
  );
  await audit(tx, { ...actor, action: 'campaign.resumed', entityType: 'campaign', entityId: campaignId });
}

/** Cancel unsent messages. Messages already confirmed for sending (SENDING) cannot be recalled. */
export async function cancel(tx: Tx, campaignId: string, reason: string, actor: Actor) {
  const c = await lockCampaign(tx, campaignId);
  requireStatus(c, ['PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'RUNNING', 'PAUSED'], 'cancel');
  const r = await tx.query(
    `UPDATE messages SET status = 'CANCELLED', last_error_category = 'CANCELLED', last_error_code = 'CAMPAIGN_CANCELLED', finalized_at = now()
      WHERE campaign_id = $1 AND status = 'QUEUED'`,
    [campaignId],
  );
  const inflight = await tx.query<{ leased: number; sending: number }>(
    `SELECT count(*) FILTER (WHERE status = 'LEASED')::int AS leased, count(*) FILTER (WHERE status = 'SENDING')::int AS sending
       FROM messages WHERE campaign_id = $1`,
    [campaignId],
  );
  await tx.query(`UPDATE campaigns SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2, pause_reason = $3 WHERE id = $1`, [
    campaignId,
    actor.actorId,
    reason,
  ]);
  const result = { cancelled_messages: r.rowCount ?? 0, ...inflight.rows[0]! };
  await audit(tx, { ...actor, action: 'campaign.cancelled', entityType: 'campaign', entityId: campaignId, details: { reason, ...result } });
  return result;
}

// ---------------------------------------------------------------------------
// Manual retry and reconciliation
// ---------------------------------------------------------------------------

interface MessageRow {
  id: string;
  status: string;
  campaign_id: string | null;
  phone_e164: string | null;
  last_error_category: string | null;
  attempt_count: number;
  campaign_status: string | null;
}

async function lockMessage(tx: Tx, id: string): Promise<MessageRow> {
  const { rows } = await tx.query<MessageRow>(
    `SELECT m.id, m.status, m.campaign_id, m.phone_e164, m.last_error_category, m.attempt_count, c.status AS campaign_status
       FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id WHERE m.id = $1 FOR UPDATE OF m`,
    [id],
  );
  if (!rows[0]) throw notFound('Message');
  return rows[0];
}

async function requeueChecks(tx: Tx, m: MessageRow) {
  if (!m.phone_e164) throw conflict('ERASED', 'The recipient was erased');
  const s = await tx.query('SELECT 1 FROM suppressions WHERE phone_e164 = $1 AND lifted_at IS NULL', [m.phone_e164]);
  if (s.rowCount) throw conflict('SUPPRESSED', 'The recipient has opted out or is suppressed; it will not be retried');
  if (m.campaign_status === 'CANCELLED') throw conflict('CAMPAIGN_CANCELLED', 'The campaign was cancelled');
}

async function reopenCampaign(tx: Tx, campaignId: string | null) {
  if (!campaignId) return;
  await tx.query(`UPDATE campaigns SET status = 'RUNNING', completed_at = NULL WHERE id = $1 AND status = 'COMPLETED'`, [campaignId]);
}

/** One more attempt for a FAILED message. Invalid destinations need force + a note. */
export async function manualRetry(tx: Tx, messageId: string, note: string, force: boolean, actor: Actor) {
  const m = await lockMessage(tx, messageId);
  if (m.status !== 'FAILED') throw conflict('NOT_FAILED', `Only FAILED messages can be retried (this one is ${m.status}); UNKNOWN messages must be reconciled`);
  if (m.last_error_category === 'DELIVERY_FAILURE' && !force) {
    throw conflict('DELIVERY_FAILED', 'The network reported this message undeliverable after submission. Retrying sends a new SMS; pass force=true to confirm.');
  }
  if (m.last_error_category === 'INVALID_DESTINATION' && !force) {
    throw conflict('PERMANENT_FAILURE', 'This number was rejected as invalid; pass force=true to retry anyway');
  }
  await requeueChecks(tx, m);
  await tx.query(
    `UPDATE messages SET status = 'QUEUED', next_attempt_at = now(), max_attempts = least(10, attempt_count + 1), dead_lettered_at = NULL,
            finalized_at = NULL, delivery_state = 'NONE' WHERE id = $1`,
    [messageId],
  );
  await tx.query(`INSERT INTO retry_jobs (message_id, kind, reason, requested_by) VALUES ($1, 'MANUAL', $2, $3)`, [messageId, note, actor.actorId]);
  await reopenCampaign(tx, m.campaign_id);
  await audit(tx, { ...actor, action: 'message.manual_retry', entityType: 'message', entityId: messageId, details: { note, force } });
}

export type ReconcileDecision = 'CONFIRMED_SENT' | 'CONFIRMED_NOT_SENT' | 'RESEND' | 'ABANDON';

/**
 * Resolve an UNKNOWN message.
 *  CONFIRMED_SENT     – e.g. recipient confirmed receipt. Status SUBMITTED; shown as "reconciled", never as confirmed delivery.
 *  CONFIRMED_NOT_SENT – e.g. phone's Sent folder shows nothing. Requeued.
 *  RESEND             – unknown, but the admin accepts the duplicate risk. Requeued.
 *  ABANDON            – leave it. Status FAILED (DELIVERY_UNKNOWN).
 */
export async function reconcile(tx: Tx, messageId: string, decision: ReconcileDecision, note: string, actor: Actor) {
  const m = await lockMessage(tx, messageId);
  if (m.status !== 'UNKNOWN') throw conflict('NOT_UNKNOWN', `Only UNKNOWN messages are reconciled (this one is ${m.status})`);
  if (decision === 'CONFIRMED_SENT') {
    await tx.query(`UPDATE messages SET status = 'SUBMITTED', submitted_at = coalesce(submitted_at, now()), delivery_state = 'NO_REPORT', finalized_at = now() WHERE id = $1`, [messageId]);
  } else if (decision === 'ABANDON') {
    await tx.query(`UPDATE messages SET status = 'FAILED', last_error_category = 'DELIVERY_UNKNOWN', last_error_code = 'ABANDONED_UNKNOWN', finalized_at = now() WHERE id = $1`, [messageId]);
  } else {
    await requeueChecks(tx, m);
    await tx.query(
      `UPDATE messages SET status = 'QUEUED', next_attempt_at = now(), max_attempts = least(10, attempt_count + 1), finalized_at = NULL WHERE id = $1`,
      [messageId],
    );
    await tx.query(`INSERT INTO retry_jobs (message_id, kind, reason, requested_by) VALUES ($1, 'RECONCILE_RESEND', $2, $3)`, [messageId, `${decision}: ${note}`, actor.actorId]);
    await reopenCampaign(tx, m.campaign_id);
  }
  await tx.query(`INSERT INTO reconciliations (message_id, decision, note, decided_by) VALUES ($1, $2, $3, $4)`, [messageId, decision, note, actor.actorId]);
  await audit(tx, { ...actor, action: 'message.reconciled', entityType: 'message', entityId: messageId, details: { decision, note } });
}
