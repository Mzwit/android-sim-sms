/**
 * Background jobs, run in-process on a timer. Each tick takes a PostgreSQL
 * advisory lock, so running several backend instances never doubles the work.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from './db.js';
import { withTx } from './db.js';
import { audit } from './lib/audit.js';
import { getSetting } from './lib/settings.js';
import { raiseAlert } from './services/alerts.js';
import { sweepLeases } from './services/dispatch.js';

const LOCK_KEY = 726810010;

export async function startScheduledCampaigns(db: Db): Promise<number> {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE campaigns c SET status = 'RUNNING', started_at = coalesce(started_at, now())
         FROM campaign_schedules s
        WHERE s.campaign_id = c.id AND c.status = 'SCHEDULED' AND s.start_at <= now()
        RETURNING c.id`,
    );
    for (const r of rows) await audit(tx, { actorType: 'SYSTEM', action: 'campaign.started_by_schedule', entityType: 'campaign', entityId: r.id });
    return rows.length;
  });
}

export async function completeCampaigns(db: Db): Promise<number> {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query<{ id: string; unknown: number; failed: number }>(
      `UPDATE campaigns c SET status = 'COMPLETED', completed_at = now()
        WHERE c.status = 'RUNNING'
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.campaign_id = c.id AND m.status IN ('QUEUED','LEASED','SENDING'))
        RETURNING c.id,
          (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.status = 'UNKNOWN') AS unknown,
          (SELECT count(*)::int FROM messages m WHERE m.campaign_id = c.id AND m.status = 'FAILED') AS failed`,
    );
    for (const r of rows) {
      await audit(tx, { actorType: 'SYSTEM', action: 'campaign.completed', entityType: 'campaign', entityId: r.id, details: { unknown: r.unknown, failed: r.failed } });
      await raiseAlert(
        tx,
        r.unknown > 0 ? 'WARNING' : 'INFO',
        'CAMPAIGN_COMPLETED',
        `A campaign finished sending: ${r.failed} failed, ${r.unknown} unknown${r.unknown ? ' (reconcile these before any resend)' : ''}.`,
        'campaign',
        r.id,
      );
    }
    return rows.length;
  });
}

/** SUBMITTED with no delivery report after the timeout: say so honestly. */
export async function expireDeliveryReports(db: Db): Promise<number> {
  const hours = await getSetting(db, 'delivery_report_timeout_hours');
  const r = await db.query(
    `UPDATE messages SET delivery_state = 'NO_REPORT', finalized_at = coalesce(finalized_at, now())
      WHERE delivery_state = 'AWAITING_REPORT' AND submitted_at < now() - make_interval(hours => $1)`,
    [hours],
  );
  return r.rowCount ?? 0;
}

export async function alertOfflineGateways(db: Db): Promise<number> {
  const minutes = await getSetting(db, 'gateway_offline_minutes');
  return withTx(db, async (tx) => {
    const { rows } = await tx.query<{ id: string; name: string }>(
      `UPDATE gateways g SET offline_alerted_at = now()
        WHERE g.status = 'ACTIVE' AND g.offline_alerted_at IS NULL
          AND g.last_seen_at < now() - make_interval(mins => $1)
          AND EXISTS (SELECT 1 FROM campaigns c WHERE c.status = 'RUNNING')
        RETURNING g.id, g.name`,
      [minutes],
    );
    for (const g of rows) {
      await raiseAlert(tx, 'CRITICAL', 'GATEWAY_OFFLINE', `Gateway "${g.name}" has not checked in for ${minutes}+ minutes while a campaign is running. Check the phone's power, network and that the app is running.`, 'gateway', g.id);
    }
    return rows.length;
  });
}

export interface RetentionResult {
  messages: number;
  health_events: number;
  sessions: number;
  idempotency_keys: number;
  imports: number;
  audit_logs: number;
  alerts: number;
}

/** Delete data older than the configured retention. Audit rows need the purge flag (DB trigger). */
export async function runRetention(db: Db, dryRun = false): Promise<RetentionResult> {
  const r = await getSetting(db, 'retention');
  return withTx(db, async (tx) => {
    const exec = async (sql: string, params: unknown[]) => {
      if (dryRun) {
        const countSql = sql.replace(/^DELETE FROM (\w+)/, 'SELECT count(*)::int AS n FROM $1');
        return (await tx.query<{ n: number }>(countSql, params)).rows[0]!.n;
      }
      return (await tx.query(sql, params)).rowCount ?? 0;
    };
    const res: RetentionResult = {
      messages: await exec(
        `DELETE FROM messages WHERE status IN ('DELIVERED','SUBMITTED','FAILED','CANCELLED')
          AND coalesce(finalized_at, updated_at) < now() - make_interval(days => $1)`,
        [r.messages_days],
      ),
      health_events: await exec(`DELETE FROM gateway_health_events WHERE received_at < now() - make_interval(days => $1)`, [r.health_days]),
      sessions: await exec(`DELETE FROM admin_sessions WHERE (revoked_at IS NOT NULL OR expires_at < now()) AND created_at < now() - make_interval(days => $1)`, [r.sessions_days]),
      idempotency_keys: await exec(`DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(days => $1)`, [7]),
      imports: await exec(`DELETE FROM contact_imports WHERE created_at < now() - make_interval(days => $1)`, [7]),
      alerts: await exec(`DELETE FROM alerts WHERE acknowledged_at IS NOT NULL AND created_at < now() - make_interval(days => $1)`, [90]),
      audit_logs: 0,
    };
    if (!dryRun) await tx.query(`SET LOCAL app.audit_purge = 'on'`);
    res.audit_logs = await exec(`DELETE FROM audit_logs WHERE occurred_at < now() - make_interval(days => $1)`, [r.audit_days]);
    if (!dryRun) {
      await tx.query(`SET LOCAL app.audit_purge = 'off'`);
      await audit(tx, { actorType: 'SYSTEM', action: 'retention.purged', details: { ...res, settings: r } });
      await tx.query(`INSERT INTO app_settings (key, value) VALUES ('retention_last_run', to_jsonb(now()))
                      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
    }
    return res;
  });
}

async function retentionDue(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ due: boolean }>(
    `SELECT coalesce((SELECT (value #>> '{}')::timestamptz < now() - interval '24 hours' FROM app_settings WHERE key = 'retention_last_run'), true) AS due`,
  );
  return rows[0]!.due;
}

export async function tick(db: Db): Promise<Record<string, unknown> | null> {
  const client = await db.connect();
  try {
    const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!got.rows[0]!.ok) return null;
    try {
      const out: Record<string, unknown> = {};
      out.sweep = await sweepLeases(db);
      out.started = await startScheduledCampaigns(db);
      out.completed = await completeCampaigns(db);
      out.no_report = await expireDeliveryReports(db);
      out.offline = await alertOfflineGateways(db);
      if (await retentionDue(db)) out.retention = await runRetention(db);
      return out;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export function startWorkers(db: Db, log: FastifyBaseLogger, intervalMs = 15_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const out = await tick(db);
      if (out) {
        const s = out.sweep as { requeued: number; unknown: number };
        if (s.requeued || s.unknown || out.started || out.completed || out.retention) log.info({ worker: out }, 'worker tick');
      }
    } catch (err) {
      log.error({ err }, 'worker tick failed');
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
