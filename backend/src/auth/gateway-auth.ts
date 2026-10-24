import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Db } from '../db.js';
import { sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';

export interface AuthGateway {
  id: string;
  name: string;
  credentialId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    gateway?: AuthGateway;
  }
}

/** Device-token authentication for the Android app. Admin sessions are never accepted here. */
export function makeAuthenticateGateway(db: Db): preHandlerHookHandler {
  return async function authenticateGateway(req: FastifyRequest) {
    const h = req.headers.authorization;
    const token = h?.startsWith('Gateway ') ? h.slice(8).trim() : undefined;
    if (!token || token.length < 30 || token.length > 200) throw new AppError(401, 'GATEWAY_UNAUTHENTICATED', 'Gateway token required');
    const { rows } = await db.query<{ id: string; name: string; credential_id: string; status: string; last_used_at: Date | null }>(
      `SELECT g.id, g.name, g.status, c.id AS credential_id, c.last_used_at
         FROM gateway_credentials c JOIN gateways g ON g.id = c.gateway_id
        WHERE c.token_hash = $1 AND c.revoked_at IS NULL`,
      [sha256(token)],
    );
    const r = rows[0];
    if (!r) throw new AppError(401, 'GATEWAY_UNAUTHENTICATED', 'Unknown or revoked gateway token');
    if (r.status !== 'ACTIVE') throw new AppError(403, 'GATEWAY_DISABLED', `Gateway is ${r.status}`);
    if (!r.last_used_at || Date.now() - new Date(r.last_used_at).getTime() > 60_000) {
      await db.query('UPDATE gateway_credentials SET last_used_at = now() WHERE id = $1', [r.credential_id]);
      await db.query('UPDATE gateways SET last_seen_at = now(), last_ip = $2 WHERE id = $1', [r.id, req.ip]);
    }
    req.gateway = { id: r.id, name: r.name, credentialId: r.credential_id };
  };
}
