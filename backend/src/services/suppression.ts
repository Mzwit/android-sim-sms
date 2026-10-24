import type { Tx } from '../db.js';
import { audit } from '../lib/audit.js';

export type SuppressionReason = 'OPT_OUT' | 'ADMIN' | 'COMPLAINT' | 'INVALID_NUMBER' | 'CARRIER_BLOCK';

export interface SuppressResult {
  suppressionId: string;
  alreadySuppressed: boolean;
  cancelledMessages: number;
}

/**
 * Suppress a number immediately. In the same transaction, every message to that
 * number that has not yet been handed to a phone (QUEUED) is cancelled. Messages
 * already LEASED to a phone are blocked again at send time by the gateway's
 * pre-send check (Phase 3) — see docs for the narrow race this leaves.
 */
export async function suppressNumber(
  tx: Tx,
  phoneE164: string,
  reason: SuppressionReason,
  source: string,
  note: string | null,
  actor: { actorType: 'ADMIN' | 'GATEWAY' | 'SYSTEM'; actorId: string | null; ip?: string | null },
): Promise<SuppressResult> {
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO suppressions (phone_e164, reason, source, note, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (phone_e164) WHERE lifted_at IS NULL DO NOTHING RETURNING id`,
    [phoneE164, reason, source, note, actor.actorType === 'ADMIN' ? actor.actorId : null],
  );
  let suppressionId: string;
  let alreadySuppressed = false;
  if (ins.rows[0]) suppressionId = ins.rows[0].id;
  else {
    alreadySuppressed = true;
    const ex = await tx.query<{ id: string }>('SELECT id FROM suppressions WHERE phone_e164 = $1 AND lifted_at IS NULL', [phoneE164]);
    suppressionId = ex.rows[0]!.id;
  }
  const cancelled = await tx.query(
    `UPDATE messages SET status = 'CANCELLED', last_error_category = 'SUPPRESSED', last_error_code = 'RECIPIENT_SUPPRESSED',
            finalized_at = now()
      WHERE phone_e164 = $1 AND status = 'QUEUED'`,
    [phoneE164],
  );
  // Record the withdrawal against every live contact holding this number.
  if (reason === 'OPT_OUT') {
    await tx.query(
      `INSERT INTO consent_records (contact_id, purpose, status, source, evidence, recorded_by)
       SELECT id, 'general', 'WITHDRAWN', $2, $3, $4 FROM contacts WHERE phone_e164 = $1 AND deleted_at IS NULL`,
      [phoneE164, source, note, actor.actorType === 'ADMIN' ? actor.actorId : null],
    );
  }
  await audit(tx, {
    ...actor,
    action: alreadySuppressed ? 'suppression.repeated' : 'suppression.created',
    entityType: 'suppression',
    entityId: suppressionId,
    details: { reason, source, cancelled_messages: cancelled.rowCount ?? 0 },
  });
  return { suppressionId, alreadySuppressed, cancelledMessages: cancelled.rowCount ?? 0 };
}
