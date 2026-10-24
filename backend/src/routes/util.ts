import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { normalizePhone } from '../lib/phone.js';
import { analyzeSms } from '../lib/segments.js';
import { getSetting } from '../lib/settings.js';
import { validateTemplate } from '../lib/template.js';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const { db } = app.deps;

  app.post(
    '/tools/sms-analyze',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['tools'],
        summary: 'Encoding, segment count and characters forcing Unicode for a message or template',
        body: Type.Object({ text: Type.String({ maxLength: 5000 }) }, { additionalProperties: false }),
      },
    },
    async (req) => ({ ...analyzeSms(req.body.text), template: validateTemplate(req.body.text) }),
  );

  app.post(
    '/tools/phone-check',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['tools'],
        summary: 'Normalise up to 100 numbers to E.164 without saving anything',
        body: Type.Object(
          {
            numbers: Type.Array(Type.String({ maxLength: 40 }), { minItems: 1, maxItems: 100 }),
            country: Type.Optional(Type.String({ pattern: '^[A-Z]{2}$' })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const country = req.body.country ?? (await getSetting(db, 'default_country'));
      return { country, results: req.body.numbers.map((n) => ({ input: n, ...normalizePhone(n, country) })) };
    },
  );
};

export default routes;
