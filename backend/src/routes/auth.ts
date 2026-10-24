import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { withTx } from '../db.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, unauthorized } from '../lib/errors.js';
import { burnVerify, checkPasswordPolicy, hashPassword, verifyPassword } from '../auth/password.js';
import { SESSION_COOKIE, createSession } from '../auth/session.js';
import { actor } from './common.js';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const { db, config } = app.deps;

  const cookieOpts = (expires: Date) => ({
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.cookieSecure,
    path: '/',
    expires,
  });

  app.post(
    '/auth/login',
    {
      config: { rateLimit: { max: config.loginRateLimitPerMinute, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        summary: 'Sign in and receive a session (cookie + token)',
        security: [],
        body: Type.Object(
          {
            email: Type.String({ format: 'email', maxLength: 254 }),
            password: Type.String({ minLength: 1, maxLength: 256 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const { email, password } = req.body;
      const { rows } = await db.query<{
        id: string;
        password_hash: string;
        is_active: boolean;
        locked_until: Date | null;
        failed_login_count: number;
        must_change_password: boolean;
        display_name: string;
      }>(
        `SELECT id, password_hash, is_active, locked_until, failed_login_count, must_change_password, display_name
           FROM administrators WHERE email = $1`,
        [email],
      );
      const a = rows[0];
      // Same response for unknown email, wrong password and disabled account.
      const fail = () => new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
      if (!a) {
        await burnVerify(password);
        await audit(db, { actorType: 'SYSTEM', action: 'auth.login_failed', ip: req.ip, details: { email, reason: 'unknown_email' } });
        throw fail();
      }
      if (a.locked_until && a.locked_until > new Date()) {
        await audit(db, { actorType: 'ADMIN', actorId: a.id, action: 'auth.login_blocked', ip: req.ip, details: { reason: 'locked' } });
        throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later or ask an administrator.');
      }
      const ok = await verifyPassword(a.password_hash, password);
      if (!ok || !a.is_active) {
        const failures = a.failed_login_count + 1;
        const lock = failures >= config.loginMaxAttempts;
        await db.query(
          `UPDATE administrators SET failed_login_count = $2,
                  locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END
            WHERE id = $1`,
          [a.id, lock ? 0 : failures, lock, config.loginLockMinutes],
        );
        await audit(db, {
          actorType: 'ADMIN',
          actorId: a.id,
          action: lock ? 'auth.account_locked' : 'auth.login_failed',
          ip: req.ip,
          details: { reason: a.is_active ? 'bad_password' : 'inactive' },
        });
        throw fail();
      }
      const session = await withTx(db, async (tx) => {
        await tx.query(
          `UPDATE administrators SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
          [a.id],
        );
        const s = await createSession(tx, a.id, config.sessionTtlHours, req.ip, req.headers['user-agent']);
        await audit(tx, { actorType: 'ADMIN', actorId: a.id, action: 'auth.login', ip: req.ip, entityType: 'session', entityId: s.sessionId });
        return s;
      });
      reply.setCookie(SESSION_COOKIE, session.token, cookieOpts(session.expiresAt));
      return {
        token: session.token,
        expires_at: session.expiresAt.toISOString(),
        must_change_password: a.must_change_password,
        display_name: a.display_name,
      };
    },
  );

  app.post(
    '/auth/logout',
    { preHandler: app.authenticate, schema: { tags: ['auth'], summary: 'Revoke the current session' } },
    async (req, reply) => {
      await db.query('UPDATE admin_sessions SET revoked_at = now() WHERE id = $1', [req.admin!.sessionId]);
      await audit(db, { ...actor(req), action: 'auth.logout', entityType: 'session', entityId: req.admin!.sessionId });
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    },
  );

  app.get('/auth/me', { preHandler: app.authenticate, schema: { tags: ['auth'], summary: 'Current administrator' } }, async (req) => {
    const a = req.admin!;
    return {
      id: a.id,
      email: a.email,
      display_name: a.displayName,
      role: a.roleCode,
      permissions: [...a.permissions].sort(),
      must_change_password: a.mustChangePassword,
    };
  });

  app.post(
    '/auth/change-password',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        summary: 'Change own password; revokes all other sessions',
        body: Type.Object(
          { current_password: Type.String({ maxLength: 256 }), new_password: Type.String({ maxLength: 256 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const { current_password, new_password } = req.body;
      const { rows } = await db.query<{ password_hash: string }>('SELECT password_hash FROM administrators WHERE id = $1', [
        req.admin!.id,
      ]);
      if (!rows[0] || !(await verifyPassword(rows[0].password_hash, current_password))) {
        throw unauthorized('Current password is incorrect');
      }
      if (current_password === new_password) throw badRequest('PASSWORD_UNCHANGED', 'Choose a different password');
      const policy = checkPasswordPolicy(new_password, req.admin!.email);
      if (!policy.ok) throw badRequest('WEAK_PASSWORD', 'Password does not meet the policy', policy.problems);
      const hash = await hashPassword(new_password);
      await withTx(db, async (tx) => {
        await tx.query(
          `UPDATE administrators SET password_hash = $2, must_change_password = false, password_changed_at = now() WHERE id = $1`,
          [req.admin!.id, hash],
        );
        await tx.query(`UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND id <> $2 AND revoked_at IS NULL`, [
          req.admin!.id,
          req.admin!.sessionId,
        ]);
        await audit(tx, { ...actor(req), action: 'auth.password_changed', entityType: 'administrator', entityId: req.admin!.id });
      });
      return { ok: true };
    },
  );
};

export default routes;
