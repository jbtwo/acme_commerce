import type { FastifyInstance } from 'fastify';
import { resource } from '../../http/envelope.js';
import { protectedBy } from '../../http/authorize.js';
import { quotePrice } from './service.js';
import {
  PricingParams,
  PricingQuerySchema,
  type PricingParamsType,
  type PricingQueryType,
} from './schemas.js';

const ref = (id: string) => ({ $ref: `${id}#` });

export async function registerPricingRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: PricingParamsType; Querystring: PricingQueryType }>(
    '/pricing/:sku',
    {
      onRequest: protectedBy(app, 'pricing:read'),
      schema: {
        operationId: 'getEffectivePrice',
        summary: 'Calculate the effective price for a SKU',
        description: [
          'Returns the price **and the derivation**, not just a number.',
          '',
          'The response lists every rule considered, in the order applied, with the amount each',
          'contributed — and the ones that did **not** apply, with the reason. That last part is',
          'the difference between an API a support engineer can answer a question with and one',
          'that produces a figure nobody can explain.',
          '',
          '**Order and compounding.** Rules apply in ascending `priority`, each against the',
          'running subtotal rather than the base price. Two 10% discounts therefore compound to',
          '19%, not 20%. A business decision, stated rather than implied.',
          '',
          '**Rounding.** Each step rounds to a whole minor unit, half away from zero. Each',
          'reported `amount_cents` is defined as the difference between the subtotal before and',
          'after, so the adjustments always sum exactly to `effective_unit_price_cents`.',
          '',
          'Requires `pricing:read` because `?customer_id=` returns customer-specific pricing, and',
          'commercial terms are not public.',
        ].join('\n'),
        tags: ['Pricing'],
        security: [{ bearerAuth: [] }],
        params: PricingParams,
        querystring: PricingQuerySchema,
        response: {
          200: {
            ...ref('PriceQuoteResponse'),
            description: 'The effective price and its full derivation.',
          },
          400: { ...ref('Error'), description: 'The request is malformed (`VALIDATION_ERROR`).' },
          401: {
            ...ref('Error'),
            description: 'Missing, malformed, invalid, or expired bearer token.',
          },
          403: {
            ...ref('Error'),
            description: 'Authenticated, but your role lacks `pricing:read`.',
          },
          404: {
            ...ref('Error'),
            description:
              'No such SKU (`VARIANT_NOT_FOUND`), or no price in the currency you asked for ' +
              '(`PRICING_UNAVAILABLE`).',
          },
          500: { ...ref('Error'), description: 'An unexpected server error.' },
          503: { ...ref('Error'), description: 'The database is unreachable. Safe to retry.' },
        },
      },
    },
    async (request) => resource(await quotePrice(app.db, request.params.sku, request.query)),
  );
}
