import { Type } from 'typebox';
import type { FastifyRequest } from 'fastify';

export const Uuid = Type.String({ format: 'uuid' });
export const IdParams = Type.Object({ id: Uuid });

export const Pagination = {
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
};

export function pageOf(q: { page?: number; page_size?: number }) {
  const page = q.page ?? 1;
  const pageSize = q.page_size ?? 50;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export const ErrorBody = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String(), details: Type.Optional(Type.Unknown()) }),
});

export function actor(req: FastifyRequest) {
  return { actorType: 'ADMIN' as const, actorId: req.admin?.id ?? null, ip: req.ip };
}

/** Escape LIKE wildcards in user search input. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}
