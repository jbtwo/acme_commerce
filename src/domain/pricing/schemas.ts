import { Type, type Static } from '@sinclair/typebox';

/**
 * A worked example of a price quote.
 *
 * Every number here reconciles, which for pricing is the entire point. Rules apply in
 * ascending priority against the running subtotal, and each `amount_cents` is the difference
 * the rule made to that subtotal rather than a percentage of the base price:
 *
 *   base            12900 x 3 = 38700
 *   quantity_break   -5% of 38700 = -1935  -> 36765
 *   customer_group  -10% of 36765 = -3677  -> 33088   (half-away-from-zero rounding)
 *
 * So `total_price_cents` is 33088 and the breakdown adds up to it. An example where the
 * adjustments do not reconcile with the total is how a consumer learns to compute prices
 * themselves instead of trusting the API.
 */
export const PRICE_QUOTE_EXAMPLE = {
  sku: 'ACME-BAG-BLK',
  currency: 'CAD',
  quantity: 3,
  base_price_cents: 12900,
  adjustments: [
    {
      rule_id: 'prule_3a5c7e9f1b2d4f6a8c0e1b3d',
      type: 'quantity_break',
      description: 'Buy 10 or more — 5% off',
      amount_cents: -1935,
      applied: true,
      skipped_reason: null,
    },
    {
      rule_id: 'prule_7e9f1b3d5a7c9e1f2b4d6a8c',
      type: 'customer_group',
      description: 'Wholesale customers — 10% off',
      amount_cents: -3677,
      applied: true,
      skipped_reason: null,
    },
    {
      rule_id: 'prule_1b3d5f7a9c1e3f5a7b9d1c3e',
      type: 'sale',
      description: 'Autumn sale — 15% off Backpacks',
      amount_cents: 0,
      applied: false,
      skipped_reason: 'rule has ended',
    },
  ],
  effective_unit_price_cents: 11029,
  total_price_cents: 33088,
  applied_rule_ids: ['prule_3a5c7e9f1b2d4f6a8c0e1b3d', 'prule_7e9f1b3d5a7c9e1f2b4d6a8c'],
};

export const PriceAdjustmentSchema = Type.Object(
  {
    rule_id: Type.String({ description: 'The pricing rule considered.' }),
    type: Type.String({
      description: 'Rule kind: sale, customer_group, quantity_break, or partner.',
    }),
    description: Type.String({ description: 'Human-readable rule name, safe to show a customer.' }),
    amount_cents: Type.Integer({
      description:
        'Signed change this rule made to the running subtotal, in minor units. Negative is a ' +
        'discount. Zero when `applied` is false.',
    }),
    applied: Type.Boolean({ description: 'Whether the rule actually changed the price.' }),
    skipped_reason: Type.Unsafe<string | null>({
      type: ['string', 'null'],
      description:
        'Why the rule did not apply. Null when it did. Rules that were considered and skipped ' +
        'are reported deliberately — "the wholesale discount exists and you did not get it ' +
        'because you sent no customer_id" is the answer a support engineer needs.',
    }),
  },
  {
    $id: 'PriceAdjustment',
    examples: [PRICE_QUOTE_EXAMPLE.adjustments[0]],
    title: 'PriceAdjustment',
    additionalProperties: false,
    description: 'One pricing rule and what it did.',
  },
);

export const PriceQuoteSchema = Type.Object(
  {
    sku: Type.String({ description: 'The SKU priced.' }),
    currency: Type.String({ description: 'ISO 4217 code. This API does not convert currencies.' }),
    quantity: Type.Integer({ minimum: 1, description: 'Quantity the quote was calculated for.' }),
    base_price_cents: Type.Integer({ description: 'The variant list price before any rule.' }),
    adjustments: Type.Array(Type.Unsafe<unknown>({ $ref: 'PriceAdjustment#' }), {
      description:
        'Every rule considered, in the order applied (ascending priority). Applied and skipped ' +
        'rules are both present.',
    }),
    effective_unit_price_cents: Type.Integer({
      description:
        'Price for one unit after every applicable rule. Equals `base_price_cents` plus the sum ' +
        'of `amount_cents` — the breakdown always reconciles exactly.',
    }),
    total_price_cents: Type.Integer({ description: '`effective_unit_price_cents` × `quantity`.' }),
    applied_rule_ids: Type.Array(Type.String(), {
      description: 'Just the rules that applied, for logging or audit.',
    }),
  },
  {
    $id: 'PriceQuote',
    examples: [PRICE_QUOTE_EXAMPLE],
    title: 'PriceQuote',
    additionalProperties: false,
    description:
      'An effective price with its full derivation. Rules apply in ascending priority, each ' +
      'against the running subtotal rather than the base price — so two 10% discounts compound ' +
      'to 19%, not 20%. Each step rounds to a whole minor unit, half away from zero.',
  },
);

export const PriceQuoteResponseSchema = Type.Object(
  { data: Type.Unsafe<unknown>({ $ref: 'PriceQuote#' }) },
  {
    $id: 'PriceQuoteResponse',
    examples: [{ data: PRICE_QUOTE_EXAMPLE }],
    title: 'PriceQuoteResponse',
    additionalProperties: false,
    description: 'An effective price and how it was reached.',
  },
);

export const PricingParams = Type.Object(
  { sku: Type.String({ description: 'Stock-keeping unit to price.' }) },
  { additionalProperties: false },
);
export type PricingParamsType = Static<typeof PricingParams>;

export const PricingQuerySchema = Type.Object(
  {
    customer_id: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'Unlocks customer-group pricing. Until the Customer API arrives in Milestone 3 the ' +
          'group mapping is fixture data: `customer_wholesale_001`, `customer_edu_001`, ' +
          '`customer_retail_001`.',
        examples: ['customer_wholesale_001'],
      }),
    ),
    partner_id: Type.Optional(
      Type.String({
        maxLength: 64,
        description: 'Unlocks partner-specific pricing. No partner rules are seeded yet.',
      }),
    ),
    quantity: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 1_000_000,
        default: 1,
        description: 'Units. Drives quantity-break rules.',
      }),
    ),
    currency: Type.Optional(
      Type.String({
        pattern: '^[A-Z]{3}$',
        description:
          "Assert the currency you expect. Mismatching the price's own currency returns 404 " +
          'rather than converting — a wrong exchange rate silently applied is worse than a refusal.',
      }),
    ),
  },
  { additionalProperties: false },
);
export type PricingQueryType = Static<typeof PricingQuerySchema>;

export const PRICING_SHARED_SCHEMAS = [
  PriceAdjustmentSchema,
  PriceQuoteSchema,
  PriceQuoteResponseSchema,
];
