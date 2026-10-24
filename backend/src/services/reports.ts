import type { Queryable } from '../db.js';
import { estimateCost } from '../lib/segments.js';

export interface CampaignProgress {
  total: number;
  by_status: Record<string, number>;
  by_delivery_state: Record<string, number>;
  pending: number;
  submitted: number;
  confirmed_delivered: number;
  failed: number;
  unknown: number;
  cancelled: number;
  awaiting_report: number;
  no_report: number;
  reconciled_as_sent: number;
  segments_submitted: number;
  rate_per_minute: number;
  rate_window_minutes: number;
  eta: { minutes: number | null; at: string | null; note: string };
}

const RATE_WINDOW_MIN = 15;

export async function campaignProgress(q: Queryable, campaignId: string): Promise<CampaignProgress> {
  const [{ rows: s }, { rows: d }, { rows: r }, { rows: rec }] = await Promise.all([
    q.query<{ status: string; n: number; seg: number }>(
      `SELECT status, count(*)::int AS n, coalesce(sum(segment_count) FILTER (WHERE submitted_at IS NOT NULL), 0)::int AS seg
         FROM messages WHERE campaign_id = $1 GROUP BY status`,
      [campaignId],
    ),
    q.query<{ delivery_state: string; n: number }>(
      `SELECT delivery_state, count(*)::int AS n FROM messages WHERE campaign_id = $1 GROUP BY delivery_state`,
      [campaignId],
    ),
    q.query<{ n: number; first: Date | null }>(
      `SELECT count(*)::int AS n, min(submitted_at) AS first FROM messages
        WHERE campaign_id = $1 AND submitted_at > now() - make_interval(mins => $2)`,
      [campaignId, RATE_WINDOW_MIN],
    ),
    q.query<{ n: number }>(
      `SELECT count(DISTINCT r.message_id)::int AS n FROM reconciliations r JOIN messages m ON m.id = r.message_id
        WHERE m.campaign_id = $1 AND r.decision = 'CONFIRMED_SENT' AND m.status = 'SUBMITTED'`,
      [campaignId],
    ),
  ]);
  const by_status = Object.fromEntries(s.map((x) => [x.status, x.n]));
  const by_delivery_state = Object.fromEntries(d.map((x) => [x.delivery_state, x.n]));
  const get = (k: string) => by_status[k] ?? 0;
  const total = s.reduce((a, x) => a + x.n, 0);
  const pending = get('QUEUED') + get('LEASED') + get('SENDING');
  // Rate measured from actual submissions in the window (not a configured speed).
  const recent = r[0]!;
  const spanMin = recent.first ? Math.max(1, (Date.now() - new Date(recent.first).getTime()) / 60_000) : RATE_WINDOW_MIN;
  const rate = recent.n > 0 ? recent.n / Math.min(RATE_WINDOW_MIN, spanMin) : 0;
  const etaMin = rate > 0 && pending > 0 ? Math.ceil(pending / rate) : pending === 0 ? 0 : null;
  return {
    total,
    by_status,
    by_delivery_state,
    pending,
    submitted: get('SUBMITTED') + get('DELIVERED'),
    confirmed_delivered: get('DELIVERED'),
    failed: get('FAILED'),
    unknown: get('UNKNOWN'),
    cancelled: get('CANCELLED'),
    awaiting_report: by_delivery_state.AWAITING_REPORT ?? 0,
    no_report: by_delivery_state.NO_REPORT ?? 0,
    reconciled_as_sent: rec[0]?.n ?? 0,
    segments_submitted: s.reduce((a, x) => a + x.seg, 0),
    rate_per_minute: Math.round(rate * 10) / 10,
    rate_window_minutes: RATE_WINDOW_MIN,
    eta: {
      minutes: etaMin,
      at: etaMin != null ? new Date(Date.now() + etaMin * 60_000).toISOString() : null,
      note:
        etaMin == null
          ? 'No submissions in the last 15 minutes, so no estimate is possible.'
          : 'Estimate from the measured rate over the last 15 minutes while sending. Excludes pauses, sending-window closures, cooldowns and budget limits.',
    },
  };
}

export async function campaignReport(q: Queryable, campaignId: string) {
  const { rows } = await q.query(
    `SELECT c.id, c.name, c.status, c.body_template, c.created_at, c.approved_at, c.started_at, c.completed_at, c.cancelled_at,
            c.cost_per_segment, c.currency, c.segments_estimated, c.recipients_included, c.recipients_excluded, c.pause_reason,
            a1.display_name AS created_by_name, a2.display_name AS approved_by_name
       FROM campaigns c JOIN administrators a1 ON a1.id = c.created_by LEFT JOIN administrators a2 ON a2.id = c.approved_by
      WHERE c.id = $1`,
    [campaignId],
  );
  const c = rows[0];
  if (!c) return undefined;
  const [progress, excl, retries, firstLast, errors] = await Promise.all([
    campaignProgress(q, campaignId),
    q.query<{ exclusion_reason: string; n: number }>(
      `SELECT exclusion_reason, count(*)::int AS n FROM campaign_recipients WHERE campaign_id = $1 AND decision = 'EXCLUDED' GROUP BY 1`,
      [campaignId],
    ),
    q.query<{ auto: number; manual: number; attempts: number }>(
      `SELECT count(*) FILTER (WHERE r.kind = 'AUTO')::int AS auto, count(*) FILTER (WHERE r.kind <> 'AUTO')::int AS manual,
              (SELECT count(*)::int FROM sms_submission_attempts a JOIN messages m ON m.id = a.message_id
                WHERE m.campaign_id = $1 AND a.outcome IN ('SUBMITTED','FAILED','UNKNOWN')) AS attempts
         FROM retry_jobs r JOIN messages m ON m.id = r.message_id WHERE m.campaign_id = $1`,
      [campaignId],
    ),
    q.query<{ first: Date | null; last: Date | null }>(
      `SELECT min(submitted_at) AS first, max(submitted_at) AS last FROM messages WHERE campaign_id = $1`,
      [campaignId],
    ),
    q.query<{ code: string; category: string; n: number }>(
      `SELECT last_error_code AS code, last_error_category AS category, count(*)::int AS n FROM messages
        WHERE campaign_id = $1 AND status IN ('FAILED','UNKNOWN') GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`,
      [campaignId],
    ),
  ]);
  return {
    campaign: c,
    totals: {
      intended_recipients: (c.recipients_included ?? 0) + (c.recipients_excluded ?? 0),
      included: c.recipients_included ?? progress.total,
      excluded_by_reason: Object.fromEntries(excl.rows.map((r) => [r.exclusion_reason, r.n])),
      segments_estimated: c.segments_estimated,
      segments_submitted: progress.segments_submitted,
      submitted: progress.submitted,
      confirmed_delivered: progress.confirmed_delivered,
      submitted_awaiting_report: progress.awaiting_report,
      submitted_no_report: progress.no_report,
      reconciled_as_sent: progress.reconciled_as_sent,
      confirmed_failed: progress.failed,
      unknown: progress.unknown,
      cancelled: progress.cancelled,
      pending: progress.pending,
      submission_attempts: retries.rows[0]?.attempts ?? 0,
      automatic_retries: retries.rows[0]?.auto ?? 0,
      manual_retries: retries.rows[0]?.manual ?? 0,
    },
    cost: {
      estimated: estimateCost(c.segments_estimated ?? 0, c.cost_per_segment),
      based_on_submitted: estimateCost(progress.segments_submitted, c.cost_per_segment),
      currency: c.currency,
      note: 'Calculated from the configured cost per segment. The carrier bill is authoritative.',
    },
    timing: { first_submission: firstLast.rows[0]?.first, last_submission: firstLast.rows[0]?.last },
    top_errors: errors.rows,
    definitions: {
      submitted: 'Android reported that the phone handed every part to the mobile network (sentIntent RESULT_OK).',
      confirmed_delivered: 'The network returned a delivery report for every part.',
      submitted_no_report: 'Submitted, but no delivery report arrived within the timeout. Delivery is not confirmed.',
      reconciled_as_sent: 'Outcome was unknown; an administrator recorded that it was sent (inferred, not confirmed).',
      unknown: 'The phone may or may not have sent it. Needs reconciliation before any resend.',
    },
  };
}
