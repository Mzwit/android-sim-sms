import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { withTx, type Tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { generatePassword } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { hashPassword } from '../auth/password.js';
import { requirePerm } from '../auth/session.js';
import { IdParams, actor } from './common.js';

const ADMIN_COLUMNS = `a.id, a.email, a.display_name, r.code AS role, a.is_active, a.must_change_password,
  a.locked_until, a.last_login_at, a.created_at, a.updated_at`;

async function activeSuperAdmins(tx: Tx, excludeId: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM administrators a JOIN roles r ON r.id = a.role_id
      WHERE r.code = 'SUPER_ADMIN' AND a.is_active AND a.id <> $1`,
    [excludeId],
  );
  return rows[0]!.n;
}

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const { db } = app.deps;
  const guard = [app.authenticate, requirePerm('admins.manage')];

  app.get('/roles', { preHandler: [app.authenticate], schema: { tags: ['admins'], summary: 'Roles and their permissions' } }, async () => {
    const { rows } = await db.query(
      `SELECT r.code, r.name, r.description,
              coalesce(array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id LEFT JOIN permissions p ON p.id = rp.permission_id
        GROUP BY r.id ORDER BY r.id`,
    );
    return { items: rows };
  });

  app.get('/admins', { preHandler: guard, schema: { tags: ['admins'], summary: 'List administrators' } }, async () => {
    const { rows } = await db.query(`SELECT ${ADMIN_COLUMNS} FROM administrators a JOIN roles r ON r.id = a.role_id ORDER BY a.created_at`);
    return { items: rows };
  });

  app.post(
    '/admins',
    {
      preHandler: guard,
      schema: {
        tags: ['admins'],
        summary: 'Create an administrator. A one-time temporary password is returned once and must be changed at first sign-in.',
        body: Type.Object(
          {
            email: Type.String({ format: 'email', maxLength: 254 }),
            display_name: Type.String({ minLength: 1, maxLength: 120 }),
            role: Type.String({ minLength: 1, maxLength: 40 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const { email, display_name, role } = req.body;
      const temp = generatePassword();
      const hash = await hashPassword(temp);
      const created = await withTx(db, async (tx) => {
        const r = await tx.query<{ id: number }>('SELECT id FROM roles WHERE code = $1', [role]);
        if (!r.rows[0]) throw badRequest('UNKNOWN_ROLE', `Role ${role} does not exist`);
        const dup = await tx.query('SELECT 1 FROM administrators WHERE email = $1', [email]);
        if (dup.rowCount) throw conflict('EMAIL_TAKEN', 'An administrator with this email already exists');
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO administrators (email, display_name, password_hash, role_id, must_change_password)
           VALUES ($1, $2, $3, $4, true) RETURNING id`,
          [email, display_name.trim(), hash, r.rows[0].id],
        );
        await audit(tx, { ...actor(req), action: 'admin.created', entityType: 'administrator', entityId: rows[0]!.id, details: { email, role } });
        return rows[0]!.id;
      });
      reply.code(201);
      return { id: created, email, role, temporary_password: temp, note: 'Shown once. The user must change it at first sign-in.' };
    },
  );

  app.patch(
    '/admins/:id',
    {
      preHandler: guard,
      schema: {
        tags: ['admins'],
        summary: 'Change role, name or active status',
        params: IdParams,
        body: Type.Object(
          {
            display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
            role: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
            is_active: Type.Optional(Type.Boolean()),
            unlock: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const { id } = req.params;
      const b = req.body;
      return withTx(db, async (tx) => {
        const cur = await tx.query<{ role: string; is_active: boolean }>(
          `SELECT r.code AS role, a.is_active FROM administrators a JOIN roles r ON r.id = a.role_id WHERE a.id = $1 FOR UPDATE OF a`,
          [id],
        );
        if (!cur.rows[0]) throw notFound('Administrator');
        if (id === req.admin!.id && (b.is_active === false || (b.role && b.role !== cur.rows[0].role))) {
          throw badRequest('SELF_LOCKOUT', 'You cannot deactivate yourself or change your own role');
        }
        const losingSuper =
          cur.rows[0].role === 'SUPER_ADMIN' && ((b.role && b.role !== 'SUPER_ADMIN') || b.is_active === false);
        if (losingSuper) {
          // Serialise concurrent demotions so two admins cannot demote each other simultaneously.
          await tx.query('SELECT pg_advisory_xact_lock(726810002)');
          if ((await activeSuperAdmins(tx, id)) === 0) {
            throw badRequest('LAST_SUPER_ADMIN', 'At least one active super administrator must remain');
          }
        }
        let roleId: number | undefined;
        if (b.role) {
          const r = await tx.query<{ id: number }>('SELECT id FROM roles WHERE code = $1', [b.role]);
          if (!r.rows[0]) throw badRequest('UNKNOWN_ROLE', `Role ${b.role} does not exist`);
          roleId = r.rows[0].id;
        }
        await tx.query(
          `UPDATE administrators SET
             display_name = coalesce($2, display_name),
             role_id = coalesce($3, role_id),
             is_active = coalesce($4, is_active),
             locked_until = CASE WHEN $5 THEN NULL ELSE locked_until END,
             failed_login_count = CASE WHEN $5 THEN 0 ELSE failed_login_count END
           WHERE id = $1`,
          [id, b.display_name?.trim() ?? null, roleId ?? null, b.is_active ?? null, b.unlock === true],
        );
        if (b.is_active === false || b.role) {
          await tx.query('UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL', [id]);
        }
        await audit(tx, { ...actor(req), action: 'admin.updated', entityType: 'administrator', entityId: id, details: b });
        const { rows } = await tx.query(`SELECT ${ADMIN_COLUMNS} FROM administrators a JOIN roles r ON r.id = a.role_id WHERE a.id = $1`, [id]);
        return rows[0];
      });
    },
  );

  app.post(
    '/admins/:id/reset-password',
    { preHandler: guard, schema: { tags: ['admins'], summary: 'Issue a new temporary password and sign the user out everywhere', params: IdParams } },
    async (req) => {
      const temp = generatePassword();
      const hash = await hashPassword(temp);
      await withTx(db, async (tx) => {
        const r = await tx.query(
          `UPDATE administrators SET password_hash = $2, must_change_password = true, failed_login_count = 0,
                  locked_until = NULL, password_changed_at = now() WHERE id = $1`,
          [req.params.id, hash],
        );
        if (!r.rowCount) throw notFound('Administrator');
        await tx.query('UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL', [req.params.id]);
        await audit(tx, { ...actor(req), action: 'admin.password_reset', entityType: 'administrator', entityId: req.params.id });
      });
      return { temporary_password: temp, note: 'Shown once. The user must change it at next sign-in.' };
    },
  );
};

export default routes;
