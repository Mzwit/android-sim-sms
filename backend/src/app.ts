import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { readFileSync } from 'node:fs';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { AppError, fromPgError } from './lib/errors.js';
import { makeAuthenticate } from './auth/session.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admins.js';
import contactRoutes from './routes/contacts.js';
import groupRoutes from './routes/groups.js';
import consentRoutes from './routes/consent.js';
import campaignRoutes from './routes/campaigns.js';
import auditRoutes from './routes/audit.js';
import settingsRoutes from './routes/settings.js';
import utilRoutes from './routes/util.js';

export interface AppDeps {
  config: Config;
  db: Db;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
    authenticate: import('fastify').preHandlerHookHandler;
  }
}

export type App = FastifyInstance;
export const API_PREFIX = '/api/v1';

export async function buildApp(deps: AppDeps) {
  const { config } = deps;
  const https =
    config.tlsCertPath && config.tlsKeyPath
      ? { cert: readFileSync(config.tlsCertPath), key: readFileSync(config.tlsKeyPath) }
      : null;

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[redacted]',
      },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    ...(https ? { https } : {}),
    ajv: { customOptions: { removeAdditional: true, coerceTypes: 'array', useDefaults: true, allErrors: true } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate('deps', deps);
  app.decorate('authenticate', makeAuthenticate(deps.db, config.sessionTtlHours));

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'"], // swagger-ui inline styles
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: https ? { maxAge: 15552000 } : false,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: config.apiRateLimitPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: { code: 'RATE_LIMITED', message: `Too many requests; retry in ${Math.ceil(ctx.ttl / 1000)}s` },
    }),
  });

  if (config.enableDocs) {
    await app.register(swagger, {
      openapi: {
        openapi: '3.0.3',
        info: {
          title: 'Android SIM SMS Gateway API',
          version: '0.2.0',
          description:
            'Administrator API for the consent-based SMS gateway. Authenticate with POST /api/v1/auth/login. ' +
            'Browser clients use the HttpOnly session cookie and must send header `x-smsgw-csrf: 1` on writes; ' +
            'scripts may use `Authorization: Bearer <token>`.',
        },
        components: {
          securitySchemes: {
            bearer: { type: 'http', scheme: 'bearer' },
            cookie: { type: 'apiKey', in: 'cookie', name: 'smsgw_session' },
          },
        },
        security: [{ bearer: [] }, { cookie: [] }],
      },
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const fe = err as FastifyError;
    if (fe.validation) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          details: fe.validation.map((v) => ({ path: v.instancePath || v.params?.missingProperty, message: v.message })),
        },
      });
    }
    if (fe.statusCode === 429) return reply.code(429).send(err);
    const pg = fromPgError(err);
    if (pg) return reply.code(pg.statusCode).send({ error: { code: pg.code, message: pg.message, details: pg.details } });
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.code(fe.statusCode).send({ error: { code: fe.code ?? 'BAD_REQUEST', message: fe.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` } }),
  );

  // Liveness/readiness: no auth, reveals nothing sensitive.
  app.get('/healthz', { config: { rateLimit: false }, schema: { hide: true } }, async (_req, reply) => {
    try {
      await deps.db.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'db_unavailable' });
    }
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(adminRoutes);
      await api.register(contactRoutes);
      await api.register(groupRoutes);
      await api.register(consentRoutes);
      await api.register(campaignRoutes);
      await api.register(auditRoutes);
      await api.register(settingsRoutes);
      await api.register(utilRoutes);
    },
    { prefix: API_PREFIX },
  );

  return app;
}
