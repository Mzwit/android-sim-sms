import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { withTx } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { requirePerm } from '../auth/session.js';
import { IdParams, Uuid, actor } from './common.js';

const GroupBody = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 100 }), description: Type.Optional(Type.String({ maxLength: 500 })) },
  { additionalProperties: false },
);

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const { db } = app.deps;
  const read = [app.authenticate, requirePerm('contacts.read')];
  const write = [app.authenticate, requirePerm('groups.write')];

  app.get('/groups', { preHandler: read, schema: { tags: ['groups'], summary: 'List groups with member counts' } }, async () => {
    const { rows } = await db.query(
      `SELECT g.id, g.name, g.description, g.created_at, g.updated_at,
              count(c.id)::int AS member_count,
              count(c.id) FILTER (WHERE c.is_valid)::int AS valid_count
         FROM contact_groups g
         LEFT JOIN group_memberships gm ON gm.group_id = g.id
         LEFT JOIN contacts c ON c.id = gm.contact_id AND c.deleted_at IS NULL
        GROUP BY g.id ORDER BY g.name`,
    );
    return { items: rows };
  });

  app.post('/groups', { preHandler: write, schema: { tags: ['groups'], body: GroupBody } }, async (req, reply) => {
    const g = await withTx(db, async (tx) => {
      const dup = await tx.query('SELECT 1 FROM contact_groups WHERE name = $1', [req.body.name.trim()]);
      if (dup.rowCount) throw conflict('GROUP_EXISTS', 'A group with this name already exists');
      const { rows } = await tx.query(
        'INSERT INTO contact_groups (name, description, created_by) VALUES ($1, $2, $3) RETURNING id, name, description, created_at',
        [req.body.name.trim(), req.body.description ?? '', req.admin!.id],
      );
      await audit(tx, { ...actor(req), action: 'group.created', entityType: 'group', entityId: rows[0].id, details: { name: rows[0].name } });
      return rows[0];
    });
    reply.code(201);
    return g;
  });

  app.patch(
    '/groups/:id',
    { preHandler: write, schema: { tags: ['groups'], params: IdParams, body: Type.Partial(GroupBody) } },
    async (req) =>
      withTx(db, async (tx) => {
        const { rows } = await tx.query(
          `UPDATE contact_groups SET name = coalesce($2, name), description = coalesce($3, description)
            WHERE id = $1 RETURNING id, name, description, updated_at`,
          [req.params.id, req.body.name?.trim() ?? null, req.body.description ?? null],
        );
        if (!rows[0]) throw notFound('Group');
        await audit(tx, { ...actor(req), action: 'group.updated', entityType: 'group', entityId: req.params.id, details: req.body });
        return rows[0];
      }),
  );

  app.delete('/groups/:id', { preHandler: write, schema: { tags: ['groups'], params: IdParams, summary: 'Delete a group (contacts are kept). Refused if used by a non-draft campaign.' } }, async (req) =>
    withTx(db, async (tx) => {
      const used = await tx.query(
        `SELECT 1 FROM campaign_groups cg JOIN campaigns c ON c.id = cg.campaign_id WHERE cg.group_id = $1 AND c.status <> 'DRAFT' LIMIT 1`,
        [req.params.id],
      );
      if (used.rowCount) throw conflict('GROUP_IN_USE', 'This group is used by a submitted campaign');
      await tx.query('DELETE FROM campaign_groups WHERE group_id = $1', [req.params.id]);
      const r = await tx.query('DELETE FROM contact_groups WHERE id = $1 RETURNING name', [req.params.id]);
      if (!r.rowCount) throw notFound('Group');
      await audit(tx, { ...actor(req), action: 'group.deleted', entityType: 'group', entityId: req.params.id, details: { name: r.rows[0].name } });
      return { ok: true };
    }),
  );

  const Members = Type.Object({ contact_ids: Type.Array(Uuid, { minItems: 1, maxItems: 10000, uniqueItems: true }) }, { additionalProperties: false });

  app.post('/groups/:id/members', { preHandler: write, schema: { tags: ['groups'], params: IdParams, body: Members } }, async (req) =>
    withTx(db, async (tx) => {
      const g = await tx.query('SELECT 1 FROM contact_groups WHERE id = $1', [req.params.id]);
      if (!g.rowCount) throw notFound('Group');
      const valid = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [req.body.contact_ids]);
      if (valid.rows[0]!.n !== req.body.contact_ids.length) throw badRequest('UNKNOWN_CONTACT', 'One or more contact_ids do not exist');
      const r = await tx.query(
        `INSERT INTO group_memberships (group_id, contact_id, added_by) SELECT $1, c, $3 FROM unnest($2::uuid[]) c ON CONFLICT DO NOTHING`,
        [req.params.id, req.body.contact_ids, req.admin!.id],
      );
      await audit(tx, { ...actor(req), action: 'group.members_added', entityType: 'group', entityId: req.params.id, details: { requested: req.body.contact_ids.length, added: r.rowCount } });
      return { added: r.rowCount, already_members: req.body.contact_ids.length - (r.rowCount ?? 0) };
    }),
  );

  app.delete('/groups/:id/members', { preHandler: write, schema: { tags: ['groups'], params: IdParams, body: Members } }, async (req) =>
    withTx(db, async (tx) => {
      const r = await tx.query('DELETE FROM group_memberships WHERE group_id = $1 AND contact_id = ANY($2::uuid[])', [req.params.id, req.body.contact_ids]);
      await audit(tx, { ...actor(req), action: 'group.members_removed', entityType: 'group', entityId: req.params.id, details: { removed: r.rowCount } });
      return { removed: r.rowCount };
    }),
  );
};

export default routes;
