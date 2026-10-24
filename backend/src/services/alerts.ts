import type { Queryable } from '../db.js';

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

/**
 * Raise a dashboard alert. An identical open alert (same kind + entity) within
 * the last hour is not duplicated, so a flapping condition does not flood the list.
 */
export async function raiseAlert(
  q: Queryable,
  severity: Severity,
  kind: string,
  message: string,
  entityType?: string,
  entityId?: string,
): Promise<void> {
  await q.query(
    `INSERT INTO alerts (severity, kind, message, entity_type, entity_id)
     SELECT $1, $2, $3, $4, $5
      WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE kind = $2 AND entity_type IS NOT DISTINCT FROM $4
                          AND entity_id IS NOT DISTINCT FROM $5 AND acknowledged_at IS NULL
                          AND created_at > now() - interval '1 hour')`,
    [severity, kind, message.slice(0, 500), entityType ?? null, entityId ?? null],
  );
}
