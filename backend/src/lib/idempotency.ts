import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db, Tx } from '../db.js';
import { withTx } from '../db.js';
import { hashJson, safeEqual } from './crypto.js';
import { badRequest, unprocessable, unauthorized } from './errors.js';

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

/**
 * Execute a create-style operation at most once per (admin, Idempotency-Key).
 *
 * The key row is inserted in the same transaction as the operation. A
 * concurrent request with the same key blocks on the row lock until the first
 * commits, then replays the stored response. Reusing a key with a different
 * body is rejected with 422.
 */
export async function idempotent<T>(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  route: string,
  successStatus: number,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!req.admin) throw unauthorized();
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-128 chars: letters, digits, - _ : .)');
  }
  const requestHash = hashJson({ route, body: req.body ?? null });

  return withTx(db, async (tx) => {
    const ins = await tx.query(
      `INSERT INTO idempotency_keys (admin_id, idem_key, route, request_hash)
       VALUES ($1, $2, $3, $4) ON CONFLICT (admin_id, idem_key) DO NOTHING RETURNING idem_key`,
      [req.admin!.id, key, route, requestHash],
    );
    if (ins.rowCount === 1) {
      const result = await fn(tx);
      await tx.query(
        `UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE admin_id = $1 AND idem_key = $2`,
        [req.admin!.id, key, successStatus, JSON.stringify(result)],
      );
      reply.code(successStatus);
      return result;
    }
    const { rows } = await tx.query<{
      route: string;
      request_hash: Buffer;
      response_status: number | null;
      response_body: T | null;
    }>(`SELECT route, request_hash, response_status, response_body FROM idempotency_keys WHERE admin_id = $1 AND idem_key = $2`, [
      req.admin!.id,
      key,
    ]);
    const prev = rows[0]!;
    if (prev.route !== route || !safeEqual(prev.request_hash, requestHash)) {
      throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
    }
    reply.header('Idempotent-Replayed', 'true');
    reply.code(prev.response_status ?? successStatus);
    return prev.response_body as T;
  });
}
