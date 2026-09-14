/**
 * Inventory levels and pricing rules.
 *
 * Levels are chosen so every documented query returns something interesting: SKUs that are
 * plentiful, SKUs that are nearly out, SKUs stocked at one location and not another, and at
 * least one at zero. `?available_below=5` has to find something, or the filter is untestable.
 */

/** `[sku, locationHandle, onHand]`. Anything not listed is simply not stocked there. */
export const SEED_INVENTORY: [string, string, number][] = [
  // Flagship backpack — everywhere, healthy.
  ['ACME-BAG-BLK', 'toronto-warehouse', 142],
  ['ACME-BAG-BLK', 'vancouver-warehouse', 88],
  ['ACME-BAG-BLK', 'barrie-retail', 12],
  ['ACME-BAG-OLV', 'toronto-warehouse', 64],
  ['ACME-BAG-OLV', 'vancouver-warehouse', 30],
  ['ACME-BAG-SLT', 'toronto-warehouse', 3], // nearly out — finds available_below
  // Multi-day pack, warehouse only.
  ['SUM-PACK45-GRY-S', 'toronto-warehouse', 21],
  ['SUM-PACK45-GRY-M', 'toronto-warehouse', 44],
  ['SUM-PACK45-GRY-L', 'toronto-warehouse', 17],
  ['SUM-PACK45-RED-M', 'vancouver-warehouse', 9],
  // Daypack.
  ['ACME-DAY18-BLK', 'toronto-warehouse', 210],
  ['ACME-DAY18-TEA', 'barrie-retail', 4],
  // Tents.
  ['ACME-TENT2-GRN', 'toronto-warehouse', 33],
  ['ACME-TENT2-SND', 'vancouver-warehouse', 18],
  ['SUM-TENT4-ORG', 'toronto-warehouse', 7],
  ['SUM-TENT4-GRY', 'toronto-warehouse', 0], // out of stock entirely
  // Sleeping bags.
  ['ACME-BAG-DWN-REG', 'toronto-warehouse', 26],
  ['ACME-BAG-DWN-LNG', 'vancouver-warehouse', 11],
  // Footwear — a full size run at one warehouse.
  ['CSC-RUN-M09', 'vancouver-warehouse', 15],
  ['CSC-RUN-M10', 'vancouver-warehouse', 28],
  ['CSC-RUN-M11', 'vancouver-warehouse', 19],
  ['CSC-RUN-W07', 'vancouver-warehouse', 2], // nearly out
  ['CSC-RUN-W08', 'vancouver-warehouse', 24],
  // Bottles — high volume, all three locations.
  ['ACME-BTL-500-BLK', 'toronto-warehouse', 340],
  ['ACME-BTL-750-BLK', 'toronto-warehouse', 295],
  ['ACME-BTL-750-BLK', 'barrie-retail', 36],
  ['ACME-BTL-750-WHT', 'vancouver-warehouse', 120],
  // Apparel.
  ['CSC-SHELL-BLU-S', 'toronto-warehouse', 14],
  ['CSC-SHELL-BLU-M', 'toronto-warehouse', 31],
  ['CSC-SHELL-BLU-L', 'toronto-warehouse', 8],
  ['NWT-MERINO-CHR-S', 'barrie-retail', 6],
  ['NWT-MERINO-CHR-M', 'barrie-retail', 11],
  ['NWT-MERINO-NAV-M', 'toronto-warehouse', 47],
  // Accessories and lighting.
  ['NWT-PAN-20-BLK', 'toronto-warehouse', 52],
  ['NWT-PAN-20-YEL', 'toronto-warehouse', 1], // last one
  ['ACME-LAMP-350', 'toronto-warehouse', 96],
  ['ACME-LAMP-350-RC', 'vancouver-warehouse', 63],
  ['SUM-POLE-ALU', 'toronto-warehouse', 40],
  ['SUM-POLE-CRB', 'vancouver-warehouse', 13],
  // Bicycles — retail floor only, low counts.
  ['BBW-CRUISE-48', 'barrie-retail', 2],
  ['BBW-CRUISE-52', 'barrie-retail', 3],
  ['BBW-CRUISE-56', 'barrie-retail', 1],
  // Toques.
  ['NWT-TOQUE-OAT', 'barrie-retail', 22],
  ['NWT-TOQUE-FOR', 'barrie-retail', 18],
  ['NWT-TOQUE-RST', 'toronto-warehouse', 55],
];

export interface SeedPricingRule {
  handle: string;
  name: string;
  type: 'sale' | 'customer_group' | 'quantity_break' | 'partner';
  scope_kind: 'all' | 'product_type' | 'sku';
  scope_value: string | null;
  adjustment_kind: 'percentage' | 'fixed_amount';
  /** Basis points for percentage (-1500 = 15% off); minor units for fixed_amount. */
  adjustment_value: number;
  min_quantity: number | null;
  customer_group: string | null;
  partner_id: string | null;
  priority: number;
}

/**
 * Rules are applied in ascending `priority`, each against the **running subtotal** rather than
 * the base price. That means two 10% discounts compound to 19%, not 20% — a business decision
 * with a visible consequence, so it is documented in the operation description and asserted in
 * a test rather than left for someone to discover from a customer complaint.
 */
export const SEED_PRICING_RULES: SeedPricingRule[] = [
  {
    handle: 'autumn-backpack-sale',
    name: 'Autumn sale — 15% off Backpacks',
    type: 'sale',
    scope_kind: 'product_type',
    scope_value: 'Backpacks',
    adjustment_kind: 'percentage',
    adjustment_value: -1500,
    min_quantity: null,
    customer_group: null,
    partner_id: null,
    priority: 10,
  },
  {
    handle: 'clearance-anorak',
    name: 'Clearance — Cascade Classic Anorak',
    type: 'sale',
    scope_kind: 'sku',
    scope_value: 'CSC-ANRK-YEL-M',
    adjustment_kind: 'fixed_amount',
    adjustment_value: -2000,
    min_quantity: null,
    customer_group: null,
    partner_id: null,
    priority: 10,
  },
  {
    handle: 'qty-break-10',
    name: 'Buy 10 or more — 5% off',
    type: 'quantity_break',
    scope_kind: 'all',
    scope_value: null,
    adjustment_kind: 'percentage',
    adjustment_value: -500,
    min_quantity: 10,
    customer_group: null,
    partner_id: null,
    priority: 20,
  },
  {
    handle: 'qty-break-50',
    name: 'Buy 50 or more — 12% off',
    type: 'quantity_break',
    scope_kind: 'all',
    scope_value: null,
    adjustment_kind: 'percentage',
    adjustment_value: -1200,
    min_quantity: 50,
    customer_group: null,
    partner_id: null,
    priority: 21,
  },
  {
    handle: 'wholesale-tier',
    name: 'Wholesale customers — 10% off',
    type: 'customer_group',
    scope_kind: 'all',
    scope_value: null,
    adjustment_kind: 'percentage',
    adjustment_value: -1000,
    min_quantity: null,
    customer_group: 'wholesale',
    partner_id: null,
    priority: 30,
  },
  {
    handle: 'education-tier',
    name: 'Education customers — $5 off',
    type: 'customer_group',
    scope_kind: 'all',
    scope_value: null,
    adjustment_kind: 'fixed_amount',
    adjustment_value: -500,
    min_quantity: null,
    customer_group: 'education',
    partner_id: null,
    priority: 30,
  },
];

/**
 * Which seeded customers belong to which pricing group.
 *
 * A stand-in until the Customer API arrives in Milestone 3, at which point the group moves
 * onto the customer record and this table goes away. Kept in seed data rather than the
 * database precisely so it is obviously temporary.
 */
export const SEED_CUSTOMER_GROUPS: Record<string, string> = {
  customer_wholesale_001: 'wholesale',
  customer_edu_001: 'education',
  customer_retail_001: 'retail',
};

export const SEED_INVENTORY_EXPECTED = {
  levels: SEED_INVENTORY.length,
  rules: SEED_PRICING_RULES.length,
};
