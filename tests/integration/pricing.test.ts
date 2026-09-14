import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createTestHarness,
  json,
  type ApiError,
  type TestHarness,
} from '../helpers/app.js';

let h: TestHarness;
let auth: string;

interface Quote {
  sku: string;
  currency: string;
  quantity: number;
  base_price_cents: number;
  adjustments: {
    rule_id: string;
    description: string;
    amount_cents: number;
    applied: boolean;
    skipped_reason: string | null;
  }[];
  effective_unit_price_cents: number;
  total_price_cents: number;
  applied_rule_ids: string[];
}

beforeAll(async () => {
  h = await createTestHarness();
  auth = await bearer(h, 'developer');
});
afterAll(async () => {
  await h?.close();
});

const quote = async (sku: string, query = ''): Promise<Quote> => {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/v1/pricing/${sku}${query}`,
    headers: { authorization: auth },
  });
  expect(res.statusCode, res.body).toBe(200);
  return json<{ data: Quote }>(res.body).data;
};

describe('the breakdown always reconciles', () => {
  it.each([
    ['plain', 'ACME-BAG-BLK', ''],
    ['quantity break', 'ACME-BAG-BLK', '?quantity=10'],
    ['two breaks compounding', 'ACME-BAG-BLK', '?quantity=50'],
    ['customer group', 'ACME-BAG-BLK', '?quantity=10&customer_id=customer_wholesale_001'],
    ['fixed amount', 'ACME-BTL-750-BLK', '?customer_id=customer_edu_001'],
    ['no rules apply', 'ACME-LAMP-350', ''],
  ])('%s: adjustments sum exactly to the effective price', async (_l, sku, query) => {
    const q = await quote(sku, query);
    const sum = q.base_price_cents + q.adjustments.reduce((n, a) => n + a.amount_cents, 0);
    // Each amount is defined as the difference between subtotals, so this can never drift by
    // a rounding cent — which is exactly what it is there to guarantee.
    expect(sum).toBe(q.effective_unit_price_cents);
    expect(q.total_price_cents).toBe(q.effective_unit_price_cents * q.quantity);
  });
});

describe('rule application', () => {
  it('applies the product-type sale to a backpack', async () => {
    const q = await quote('ACME-BAG-BLK');
    const sale = q.adjustments.find((a) => a.description.includes('Autumn sale'))!;
    expect(sale.applied).toBe(true);
    expect(sale.amount_cents).toBe(-1935); // 15% of 12900
    expect(q.effective_unit_price_cents).toBe(10965);
  });

  it('does not apply it to something that is not a backpack', async () => {
    const q = await quote('ACME-LAMP-350');
    const sale = q.adjustments.find((a) => a.description.includes('Autumn sale'))!;
    expect(sale.applied).toBe(false);
    expect(sale.skipped_reason).toMatch(/product type/);
    expect(q.effective_unit_price_cents).toBe(q.base_price_cents);
  });

  it('compounds rather than summing percentages', async () => {
    // 15% then 5%, each on the running subtotal: 12900 -> 10965 -> 10417.
    // Summing the percentages (20%) would give 10320. The difference is the whole point.
    const q = await quote('ACME-BAG-BLK', '?quantity=10');
    expect(q.effective_unit_price_cents).toBe(10417);
    expect(q.effective_unit_price_cents).not.toBe(Math.round(12900 * 0.8));
  });

  it('applies rules in ascending priority', async () => {
    const q = await quote('ACME-BAG-BLK', '?quantity=50&customer_id=customer_wholesale_001');
    const appliedOrder = q.adjustments.filter((a) => a.applied).map((a) => a.description);
    expect(appliedOrder[0]).toMatch(/Autumn sale/); // priority 10
    expect(appliedOrder.at(-1)).toMatch(/Wholesale/); // priority 30
  });

  it('reports rules that did not apply, with a reason', async () => {
    const q = await quote('ACME-BAG-BLK');
    const skipped = q.adjustments.filter((a) => !a.applied);
    expect(skipped.length).toBeGreaterThan(0);
    for (const s of skipped) {
      expect(s.skipped_reason, s.description).toBeTruthy();
      expect(s.amount_cents).toBe(0);
    }
    expect(skipped.find((s) => s.description.includes('Wholesale'))?.skipped_reason).toBe(
      'customer_id not supplied',
    );
  });

  it('explains a quantity break that was not reached', async () => {
    const q = await quote('ACME-BAG-BLK', '?quantity=3');
    const brk = q.adjustments.find((a) => a.description.includes('Buy 10 or more'))!;
    expect(brk.applied).toBe(false);
    expect(brk.skipped_reason).toMatch(/at least 10.*you asked for 3/);
  });

  it('names the group when the customer is in a different one', async () => {
    const q = await quote('ACME-BTL-750-BLK', '?customer_id=customer_retail_001');
    const wholesale = q.adjustments.find((a) => a.description.includes('Wholesale'))!;
    expect(wholesale.applied).toBe(false);
    expect(wholesale.skipped_reason).toMatch(/wholesale/);
  });

  it('applies a fixed-amount discount in minor units', async () => {
    const q = await quote('ACME-BTL-750-BLK', '?customer_id=customer_edu_001');
    expect(q.base_price_cents).toBe(4500);
    expect(q.effective_unit_price_cents).toBe(4000);
  });

  it('lists only the applied rules in applied_rule_ids', async () => {
    const q = await quote('ACME-BAG-BLK', '?quantity=10');
    const applied = q.adjustments.filter((a) => a.applied).map((a) => a.rule_id);
    expect(q.applied_rule_ids).toEqual(applied);
  });

  it('multiplies by quantity for the total', async () => {
    const q = await quote('ACME-BAG-BLK', '?quantity=10');
    expect(q.total_price_cents).toBe(q.effective_unit_price_cents * 10);
  });
});

describe('errors', () => {
  it('404s on an unknown SKU', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/pricing/NO-SUCH-SKU',
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(404);
    expect(json<ApiError>(res.body).error.code).toBe('VARIANT_NOT_FOUND');
  });

  it('refuses to convert currencies rather than inventing a rate', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/pricing/ACME-BAG-BLK?currency=USD',
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(404);
    const err = json<ApiError>(res.body).error;
    expect(err.code).toBe('PRICING_UNAVAILABLE');
    expect(err.details?.available_currency).toBe('CAD');
  });

  it("accepts the SKU's own currency", async () => {
    expect((await quote('ACME-BAG-BLK', '?currency=CAD')).currency).toBe('CAD');
  });

  it.each(['?quantity=0', '?quantity=-1', '?currency=cad', '?nonsense=1'])(
    'rejects %s with 400',
    async (query) => {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/pricing/ACME-BAG-BLK${query}`,
        headers: { authorization: auth },
      });
      expect(res.statusCode).toBe(400);
    },
  );

  it('requires pricing:read — commercial terms are not public', async () => {
    const anon = await h.app.inject({ method: 'GET', url: '/api/v1/pricing/ACME-BAG-BLK' });
    expect(anon.statusCode).toBe(401);
  });
});
