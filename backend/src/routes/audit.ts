import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { requirePerm } from '../auth/session.js';
import { Pagination, Uuid, pageOf } from './common.js';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const { db } = app.deps;

  app.get(
    '/audit-logs',
    {
      preHandler: [app.authenticate, requirePerm('audit.read')],
      schema: {
        tags: ['audit'],
        summary: 'Search the append-only audit trail',
        querystring: Type.Object({
          action: Type.Optional(Type.String({ maxLength: 80, description: 'Exact action or prefix ending in "." e.g. "campaign."' })),
          actor_id: Type.Optional(Uuid),
          entity_type: Type.Optional(Type.String({ maxLength: 40 })),
          entity_id: Type.Optional(Type.String({ maxLength: 80 })),
          from: Type.Optional(Type.String({ format: 'date-time' })),
          to: Type.Optional(Type.String({ format: 'date-time' })),
          ...Pagination,
        }),
      },
    },
    async (req) => {
      const f = req.query;
      const { page, pageSize, offset } = pageOf(f);
      const where: string[] = [];
      const params: unknown[] = [];
      const p = (v: unknown) => (params.push(v), `$${params.length}`);
      if (f.action) where.push(f.action.endsWith('.') ? `l.action LIKE ${p(f.action.replace(/[\\%_]/g, '\\$&') + '%')}` : `l.action = ${p(f.action)}`);
      if (f.actor_id) where.push(`l.actor_id = ${p(f.actor_id)}`);
      if (f.entity_type) where.push(`l.entity_type = ${p(f.entity_type)}`);
      if (f.entity_id) where.push(`l.entity_id = ${p(f.entity_id)}`);
      if (f.from) where.push(`l.occurred_at >= ${p(f.from)}`);
      if (f.to) where.push(`l.occurred_at < ${p(f.to)}`);
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const countParams = [...params];
      const { rows } = await db.query(
        `SELECT l.id, l.occurred_at, l.actor_type, l.actor_id, a.display_name AS actor_name, l.action,
                l.entity_type, l.entity_id, host(l.ip) AS ip, l.details
           FROM audit_logs l LEFT JOIN administrators a ON a.id = l.actor_id AND l.actor_type = 'ADMIN'
           ${w} ORDER BY l.occurred_at DESC, l.id DESC LIMIT ${p(pageSize)} OFFSET ${p(offset)}`,
        params,
      );
      const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs l ${w}`, countParams);
      return { items: rows, page, page_size: pageSize, total: count.rows[0]!.n };
    },
  );
};

export default routes;
