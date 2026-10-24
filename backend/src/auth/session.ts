import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Db, Queryable } from '../db.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { forbidden, unauthorized, AppError } from '../lib/errors.js';

export const SESSION_COOKIE = 'smsgw_session';
/** Custom header required on cookie-authenticated writes (blocks cross-site form posts). */
export const CSRF_HEADER = 'x-smsgw-csrf';

export interface AuthAdmin {
  id: string;
  email: string;
  displayName: string;
  roleCode: string;
  permissions: Set<string>;
  mustChangePassword: boolean;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AuthAdmin;
  }
}

export async function createSession(
  q: Queryable,
  adminId: string,
  ttlHours: number,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO admin_sessions (admin_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [adminId, sha256(token), ip ?? null, (userAgent ?? '').slice(0, 300), expiresAt],
  );
  return { token, expiresAt, sessionId: rows[0]!.id };
}

function extractToken(req: FastifyRequest): { token: string; via: 'cookie' | 'bearer' } | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return { token: h.slice(7).trim(), via: 'bearer' };
  const c = req.cookies?.[SESSION_COOKIE];
  if (c) return { token: c, via: 'cookie' };
  return undefined;
}

// Routes a user who must change their password is still allowed to call.
const PASSWORD_CHANGE_ALLOWED = new Set(['/api/v1/auth/me', '/api/v1/auth/logout', '/api/v1/auth/change-password']);

export function makeAuthenticate(db: Db, ttlHours: number): preHandlerHookHandler {
  return async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
    const t = extractToken(req);
    if (!t || t.token.length < 20 || t.token.length > 200) throw unauthorized();
    if (t.via === 'cookie' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers[CSRF_HEADER] !== '1') {
      throw new AppError(403, 'CSRF_HEADER_MISSING', `Send header ${CSRF_HEADER}: 1 with cookie-authenticated writes`);
    }
    const { rows } = await db.query<{
      session_id: string;
      admin_id: string;
      email: string;
      display_name: string;
      is_active: boolean;
      must_change_password: boolean;
      role_code: string;
      permissions: string[];
      last_seen_at: Date;
    }>(
      `SELECT s.id AS session_id, a.id AS admin_id, a.email, a.display_name, a.is_active,
              a.must_change_password, r.code AS role_code, s.last_seen_at,
              coalesce(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
         FROM admin_sessions s
         JOIN administrators a ON a.id = s.admin_id
         JOIN roles r ON r.id = a.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        GROUP BY s.id, a.id, r.code`,
      [sha256(t.token)],
    );
    const row = rows[0];
    if (!row || !row.is_active) throw unauthorized('Session expired or invalid');

    // Sliding expiry, written at most once a minute.
    if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
      await db.query(
        `UPDATE admin_sessions SET last_seen_at = now(),
                expires_at = greatest(expires_at, now() + make_interval(hours => $2)) WHERE id = $1`,
        [row.session_id, ttlHours],
      );
    }

    req.admin = {
      id: row.admin_id,
      email: row.email,
      displayName: row.display_name,
      roleCode: row.role_code,
      permissions: new Set(row.permissions),
      mustChangePassword: row.must_change_password,
      sessionId: row.session_id,
    };
    const path = req.routeOptions.url ?? req.url;
    if (row.must_change_password && !PASSWORD_CHANGE_ALLOWED.has(path)) {
      throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your password before continuing');
    }
  };
}

/** preHandler factory: the admin must hold every listed permission. */
export function requirePerm(...perms: string[]): preHandlerHookHandler {
  return async function (req: FastifyRequest) {
    if (!req.admin) throw unauthorized();
    const missing = perms.filter((p) => !req.admin!.permissions.has(p));
    if (missing.length) throw forbidden(`Missing permission: ${missing.join(', ')}`);
  };
}

export function can(req: FastifyRequest, perm: string): boolean {
  return Boolean(req.admin?.permissions.has(perm));
}
