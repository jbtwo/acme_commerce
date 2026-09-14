/**
 * Effective price calculation.
 *
 * The requirement is that the response **explain the calculation** rather than return one
 * number. So the calculator reports the base price, every rule it considered, which ones
 * applied, which were skipped and why, and how the arithmetic reached the final figure.
 *
 * Two decisions here have visible consequences and are therefore documented rather than
 * implicit, because pricing disputes are settled by whichever side can explain the number:
 *
 * **Order and compounding.** Rules apply in ascending `priority`, each against the *running
 * subtotal* rather than against the base price. Two 10% discounts therefore compound to 19%,
 * not 20%. That is a business decision, not an accident of implementation.
 *
 * **Rounding.** Each step rounds the resulting subtotal to a whole cent, half away from zero.
 * The reported adjustment is then *defined* as the difference between the subtotal before and
 * after — which guarantees the adjustments always sum exactly to the final price. Computing
 * each adjustment independently and rounding it in isolation is how a breakdown ends up
 * disagreeing with its own total by a cent.
 */
import { AppError, NotFoundError } from '../../http/errors.js';
import type { AppDatabase } from '../../db/index.js';
import type { PricingRuleRow } from '../../db/schema.js';
import { SEED_CUSTOMER_GROUPS } from '../../db/seed/inventory-data.js';

export interface PricingQuery {
  customer_id?: string | undefined;
  partner_id?: string | undefined;
  quantity?: number | undefined;
  currency?: string | undefined;
}

export interface AppliedAdjustment {
  rule_id: string;
  type: string;
  description: string;
  /** Signed, in minor units. Negative is a discount. Zero when `applied` is false. */
  amount_cents: number;
  applied: boolean;
  skipped_reason: string | null;
}

export interface PriceQuote {
  sku: string;
  currency: string;
  quantity: number;
  base_price_cents: number;
  adjustments: AppliedAdjustment[];
  effective_unit_price_cents: number;
  total_price_cents: number;
  applied_rule_ids: string[];
}

/** Half away from zero, to a whole minor unit. */
function roundCents(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Decide whether a rule applies, and if not, why not.
 *
 * Returning the reason rather than a boolean is what lets the response say "the wholesale
 * discount exists and you did not get it because you sent no customer_id" — the difference
 * between an API a support engineer can answer a question with and one that cannot.
 */
function evaluate(
  rule: PricingRuleRow,
  context: {
    sku: string;
    productType: string | null;
    quantity: number;
    customerGroup: string | null;
    partnerId: string | null;
    now: Date;
  },
): string | null {
  if (!rule.is_active) return 'rule is not active';
  if (rule.starts_at && context.now < rule.starts_at) return 'rule has not started yet';
  if (rule.ends_at && context.now > rule.ends_at) return 'rule has ended';

  if (rule.scope_kind === 'sku' && rule.scope_value !== context.sku) {
    return `rule applies only to SKU ${rule.scope_value}`;
  }
  if (rule.scope_kind === 'product_type' && rule.scope_value !== context.productType) {
    return `rule applies only to product type "${rule.scope_value}"`;
  }

  if (rule.min_quantity !== null && context.quantity < rule.min_quantity) {
    return `requires a quantity of at least ${rule.min_quantity} (you asked for ${context.quantity})`;
  }
  if (rule.customer_group !== null) {
    if (context.customerGroup === null) return 'customer_id not supplied';
    if (context.customerGroup !== rule.customer_group) {
      return `applies to the "${rule.customer_group}" customer group`;
    }
  }
  if (rule.partner_id !== null && rule.partner_id !== context.partnerId) {
    return 'applies to a different partner';
  }
  return null;
}

export async function quotePrice(
  db: AppDatabase,
  sku: string,
  query: PricingQuery,
  now: Date = new Date(),
): Promise<PriceQuote> {
  const variant = await db
    .selectFrom('variants')
    .innerJoin('products', 'products.id', 'variants.product_id')
    .select([
      'variants.sku as sku',
      'variants.price_cents as price_cents',
      'variants.currency as currency',
      'variants.status as variant_status',
      'products.product_type as product_type',
    ])
    .where('variants.sku', '=', sku)
    .executeTakeFirst();

  if (!variant) {
    throw new NotFoundError('VARIANT_NOT_FOUND', `No variant exists with SKU "${sku}".`, { sku });
  }

  const quantity = query.quantity ?? 1;
  const requestedCurrency = query.currency ?? variant.currency;
  if (requestedCurrency !== variant.currency) {
    // No conversion. Quoting in a currency the price is not held in would mean inventing an
    // exchange rate, and a wrong exchange rate silently applied is worse than a refusal.
    throw new AppError(
      'PRICING_UNAVAILABLE',
      `SKU "${sku}" is priced in ${variant.currency}; no price is available in ${requestedCurrency}.`,
      {
        details: {
          sku,
          requested_currency: requestedCurrency,
          available_currency: variant.currency,
          hint: 'This API does not convert currencies.',
        },
      },
    );
  }

  const customerGroup = query.customer_id
    ? (SEED_CUSTOMER_GROUPS[query.customer_id] ?? null)
    : null;

  const rules = await db
    .selectFrom('pricing_rules')
    .selectAll()
    .orderBy('priority', 'asc')
    .orderBy('id', 'asc')
    .execute();

  const adjustments: AppliedAdjustment[] = [];
  const appliedRuleIds: string[] = [];
  let subtotal = variant.price_cents;

  for (const rule of rules) {
    const skipped = evaluate(rule, {
      sku,
      productType: variant.product_type,
      quantity,
      customerGroup,
      partnerId: query.partner_id ?? null,
      now,
    });

    if (skipped) {
      adjustments.push({
        rule_id: rule.id,
        type: rule.type,
        description: rule.name,
        amount_cents: 0,
        applied: false,
        skipped_reason: skipped,
      });
      continue;
    }

    const before = subtotal;
    const after =
      rule.adjustment_kind === 'percentage'
        ? roundCents(before * (1 + rule.adjustment_value / 10_000))
        : roundCents(before + rule.adjustment_value);

    // Never let a stack of discounts produce a negative price.
    subtotal = Math.max(0, after);

    adjustments.push({
      rule_id: rule.id,
      type: rule.type,
      description: rule.name,
      // Defined as the difference, so the breakdown always reconciles with the total.
      amount_cents: subtotal - before,
      applied: true,
      skipped_reason: null,
    });
    appliedRuleIds.push(rule.id);
  }

  return {
    sku,
    currency: variant.currency,
    quantity,
    base_price_cents: variant.price_cents,
    adjustments,
    effective_unit_price_cents: subtotal,
    total_price_cents: subtotal * quantity,
    applied_rule_ids: appliedRuleIds,
  };
}
