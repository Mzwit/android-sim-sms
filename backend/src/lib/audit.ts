import type { Queryable } from '../db.js';

export interface AuditEntry {
  actorType: 'ADMIN' | 'GATEWAY' | 'SYSTEM';
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string | number | null;
  ip?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Write one audit row. Call with the same transaction client as the change
 * being audited so the audit entry and the change commit (or roll back) together.
 */
export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, ip, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      e.actorType,
      e.actorId ?? null,
      e.action,
      e.entityType ?? null,
      e.entityId == null ? null : String(e.entityId),
      e.ip ?? null,
      JSON.stringify(e.details ?? {}),
    ],
  );
}
