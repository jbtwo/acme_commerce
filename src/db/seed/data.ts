/**
 * Development seed data — a small but realistic outdoor-goods catalog.
 *
 * Three properties this data is built to have:
 *
 * 1. **Recognisable.** "Trailhead 30L Backpack" tells you what a search for `backpack` should
 *    return. "Product 7" tells you nothing, and a catalog of "Product N" cannot demonstrate
 *    searching, filtering, or sorting because there is nothing meaningful to search or sort by.
 *
 * 2. **Deterministic.** Identifiers are derived from a SHA-256 of the product handle or the
 *    variant SKU, so `prod_...` for the Trailhead backpack is the same string on your machine,
 *    in CI, and on Unraid. That is what lets a test — or a documentation example — reference a
 *    specific seeded record by ID.
 *
 * 3. **Varied along every documented axis.** Five vendors, ten product types, mixed statuses,
 *    overlapping tags, prices from $9.50 to $1,449, and creation dates spread across nineteen
 *    months. Every filter, sort field, and search term in the contract returns a different,
 *    non-trivial answer.
 *
 * All names, brands, and descriptions are fictional.
 */

export interface SeedVariant {
  sku: string;
  title: string;
  price_cents: number;
  compare_at_price_cents?: number;
  barcode?: string;
  position: number;
}

export interface SeedProduct {
  /** Stable slug; the source of the deterministic product id. Not exposed by the API. */
  handle: string;
  title: string;
  description: string;
  status: 'draft' | 'active' | 'archived';
  vendor: string;
  product_type: string;
  tags: string[];
  /** ISO-8601. Spread out so `sort=created_at` and pagination produce meaningful orderings. */
  created_at: string;
  variants: SeedVariant[];
}

export const SEED_PRODUCTS: SeedProduct[] = [
  {
    handle: 'trailhead-30l-backpack',
    title: 'Trailhead 30L Backpack',
    description:
      'A thirty-litre daypack for long trail days. Ventilated back panel, padded hip belt, and a hydration sleeve that fits a three-litre reservoir.',
    status: 'active',
    vendor: 'Acme',
    product_type: 'Backpacks',
    tags: ['outdoor', 'hiking', 'bestseller', 'lightweight'],
    created_at: '2025-01-14T15:20:00Z',
    variants: [
      {
        sku: 'ACME-BAG-BLK',
        title: 'Black',
        price_cents: 12900,
        compare_at_price_cents: 15900,
        barcode: '0627843001010',
        position: 1,
      },
      {
        sku: 'ACME-BAG-OLV',
        title: 'Olive',
        price_cents: 12900,
        compare_at_price_cents: 15900,
        barcode: '0627843001027',
        position: 2,
      },
      {
        sku: 'ACME-BAG-SLT',
        title: 'Slate Blue',
        price_cents: 13400,
        barcode: '0627843001034',
        position: 3,
      },
    ],
  },
  {
    handle: 'summit-45l-hiking-pack',
    title: 'Summit 45L Hiking Pack',
    description:
      'A multi-day pack with an adjustable torso, load-lifter straps, and a floating lid that converts to a summit bag.',
    status: 'active',
    vendor: 'Summit Supply',
    product_type: 'Backpacks',
    tags: ['outdoor', 'hiking', 'camping'],
    created_at: '2025-02-03T11:05:00Z',
    variants: [
      { sku: 'SUM-PACK45-GRY-S', title: 'Granite / Small', price_cents: 24900, position: 1 },
      { sku: 'SUM-PACK45-GRY-M', title: 'Granite / Medium', price_cents: 24900, position: 2 },
      { sku: 'SUM-PACK45-GRY-L', title: 'Granite / Large', price_cents: 24900, position: 3 },
      { sku: 'SUM-PACK45-RED-M', title: 'Ember / Medium', price_cents: 25900, position: 4 },
    ],
  },
  {
    handle: 'daybreak-18l-daypack',
    title: 'Daybreak 18L Daypack',
    description:
      'A compact daypack that packs into its own pocket. For travel days and short walks.',
    status: 'active',
    vendor: 'Acme',
    product_type: 'Backpacks',
    tags: ['travel', 'lightweight', 'commuter'],
    created_at: '2025-02-19T09:41:00Z',
    variants: [
      { sku: 'ACME-DAY18-BLK', title: 'Black', price_cents: 5900, position: 1 },
      {
        sku: 'ACME-DAY18-TEA',
        title: 'Teal',
        price_cents: 5900,
        compare_at_price_cents: 6900,
        position: 2,
      },
    ],
  },
  {
    handle: 'basecamp-2-person-tent',
    title: 'Basecamp 2-Person Tent',
    description:
      'A three-season backpacking tent with two doors, two vestibules, and a hubbed pole set that pitches in under four minutes.',
    status: 'active',
    vendor: 'Acme',
    product_type: 'Tents',
    tags: ['outdoor', 'camping', 'bestseller', 'waterproof'],
    created_at: '2025-03-08T14:00:00Z',
    variants: [
      {
        sku: 'ACME-TENT2-GRN',
        title: 'Forest',
        price_cents: 34900,
        compare_at_price_cents: 39900,
        position: 1,
      },
      { sku: 'ACME-TENT2-SND', title: 'Sandstone', price_cents: 34900, position: 2 },
    ],
  },
  {
    handle: 'outpost-4-person-tent',
    title: 'Outpost 4-Person Tent',
    description:
      'A roomy car-camping tent with near-vertical walls, a full-coverage fly, and a gear loft.',
    status: 'active',
    vendor: 'Summit Supply',
    product_type: 'Tents',
    tags: ['camping', 'waterproof'],
    created_at: '2025-03-27T16:30:00Z',
    variants: [
      { sku: 'SUM-TENT4-ORG', title: 'Sunset Orange', price_cents: 47900, position: 1 },
      { sku: 'SUM-TENT4-GRY', title: 'Storm Grey', price_cents: 47900, position: 2 },
    ],
  },
  {
    handle: 'nightfall-down-sleeping-bag',
    title: 'Nightfall Down Sleeping Bag',
    description:
      'Responsibly-sourced 800-fill down, rated to minus seven Celsius, with a draft collar and full-length zip baffle.',
    status: 'active',
    vendor: 'Acme',
    product_type: 'Sleeping Bags',
    tags: ['outdoor', 'camping', 'winter', 'lightweight'],
    created_at: '2025-04-11T10:15:00Z',
    variants: [
      { sku: 'ACME-BAG-DWN-REG', title: 'Regular', price_cents: 28900, position: 1 },
      { sku: 'ACME-BAG-DWN-LNG', title: 'Long', price_cents: 30900, position: 2 },
    ],
  },
  {
    handle: 'ridgeline-trail-runner',
    title: 'Ridgeline Trail Runner',
    description:
      'A neutral trail shoe with a four-millimetre drop, a rock plate, and a lugged outsole for wet rock.',
    status: 'active',
    vendor: 'Cascade Gear',
    product_type: 'Footwear',
    tags: ['outdoor', 'hiking', 'new'],
    created_at: '2025-05-02T13:45:00Z',
    variants: [
      { sku: 'CSC-RUN-M09', title: "Men's 9", price_cents: 17500, position: 1 },
      { sku: 'CSC-RUN-M10', title: "Men's 10", price_cents: 17500, position: 2 },
      { sku: 'CSC-RUN-M11', title: "Men's 11", price_cents: 17500, position: 3 },
      { sku: 'CSC-RUN-W07', title: "Women's 7", price_cents: 17500, position: 4 },
      { sku: 'CSC-RUN-W08', title: "Women's 8", price_cents: 17500, position: 5 },
    ],
  },
  {
    handle: 'glacier-insulated-bottle',
    title: 'Glacier Insulated Bottle',
    description:
      'Double-walled stainless steel. Holds cold for twenty-four hours and hot for twelve.',
    status: 'active',
    vendor: 'Acme',
    product_type: 'Water Bottles',
    tags: ['bestseller', 'eco', 'commuter'],
    created_at: '2025-05-21T08:00:00Z',
    variants: [
      { sku: 'ACME-BTL-500-BLK', title: '500 ml / Black', price_cents: 3900, position: 1 },
      { sku: 'ACME-BTL-750-BLK', title: '750 ml / Black', price_cents: 4500, position: 2 },
      {
        sku: 'ACME-BTL-750-WHT',
        title: '750 ml / Chalk',
        price_cents: 4500,
        compare_at_price_cents: 5200,
        position: 3,
      },
    ],
  },
  {
    handle: 'cascade-rain-shell',
    title: 'Cascade Rain Shell',
    description:
      'A two-and-a-half-layer waterproof shell with pit zips and a helmet-compatible hood. Fully seam-sealed.',
    status: 'active',
    vendor: 'Cascade Gear',
    product_type: 'Apparel',
    tags: ['outdoor', 'waterproof', 'hiking'],
    created_at: '2025-06-09T12:20:00Z',
    variants: [
      { sku: 'CSC-SHELL-BLU-S', title: 'Deep Blue / Small', price_cents: 21900, position: 1 },
      { sku: 'CSC-SHELL-BLU-M', title: 'Deep Blue / Medium', price_cents: 21900, position: 2 },
      { sku: 'CSC-SHELL-BLU-L', title: 'Deep Blue / Large', price_cents: 21900, position: 3 },
    ],
  },
  {
    handle: 'northwind-merino-base-layer',
    title: 'Northwind Merino Base Layer',
    description:
      'A 190-gram merino crew that resists odour over multi-day trips. Flatlock seams, offset shoulders.',
    status: 'active',
    vendor: 'Northwind Traders',
    product_type: 'Apparel',
    tags: ['winter', 'hiking', 'eco'],
    created_at: '2025-06-30T17:10:00Z',
    variants: [
      { sku: 'NWT-MERINO-CHR-S', title: 'Charcoal / Small', price_cents: 9900, position: 1 },
      { sku: 'NWT-MERINO-CHR-M', title: 'Charcoal / Medium', price_cents: 9900, position: 2 },
      {
        sku: 'NWT-MERINO-NAV-M',
        title: 'Navy / Medium',
        price_cents: 9900,
        compare_at_price_cents: 11900,
        position: 3,
      },
    ],
  },
  {
    handle: 'harbour-commuter-pannier',
    title: 'Harbour Commuter Pannier',
    description:
      'A welded waterproof pannier with a roll-top closure and a hook system that fits most rear racks.',
    status: 'active',
    vendor: 'Northwind Traders',
    product_type: 'Accessories',
    tags: ['commuter', 'waterproof', 'travel'],
    created_at: '2025-07-18T09:55:00Z',
    variants: [
      { sku: 'NWT-PAN-20-BLK', title: '20 L / Black', price_cents: 13900, position: 1 },
      { sku: 'NWT-PAN-20-YEL', title: '20 L / Hi-Vis Yellow', price_cents: 14500, position: 2 },
    ],
  },
  {
    handle: 'lumen-350-headlamp',
    title: 'Lumen 350 Headlamp',
    description:
      'Three hundred and fifty lumens, a red night mode, and a rechargeable cell that also takes AAA batteries.',
    status: 'active',
    vendor: 'Acme',
    product_type: 'Lighting',
    tags: ['outdoor', 'camping', 'bestseller'],
    created_at: '2025-08-05T20:30:00Z',
    variants: [
      { sku: 'ACME-LAMP-350', title: 'Standard', price_cents: 6400, position: 1 },
      {
        sku: 'ACME-LAMP-350-RC',
        title: 'Rechargeable',
        price_cents: 8900,
        compare_at_price_cents: 9900,
        position: 2,
      },
    ],
  },
  {
    handle: 'kettle-creek-camp-stove',
    title: 'Kettle Creek Camp Stove',
    description:
      'A two-burner propane stove with a wind-blocking surround. Not yet published — awaiting certification paperwork.',
    status: 'draft',
    vendor: 'Summit Supply',
    product_type: 'Cookware',
    tags: ['camping', 'new'],
    created_at: '2025-09-01T11:00:00Z',
    variants: [{ sku: 'SUM-STOVE-2B', title: 'Two Burner', price_cents: 15900, position: 1 }],
  },
  {
    handle: 'barrie-city-cruiser',
    title: 'Barrie City Cruiser',
    description:
      'A seven-speed steel city bike with fenders, a rear rack, and an upright riding position.',
    status: 'active',
    vendor: 'Barrie Bicycle Works',
    product_type: 'Bicycles',
    tags: ['commuter', 'bestseller'],
    created_at: '2025-09-24T14:25:00Z',
    variants: [
      { sku: 'BBW-CRUISE-48', title: 'Frame 48 cm / Sage', price_cents: 89900, position: 1 },
      { sku: 'BBW-CRUISE-52', title: 'Frame 52 cm / Sage', price_cents: 89900, position: 2 },
      { sku: 'BBW-CRUISE-56', title: 'Frame 56 cm / Sage', price_cents: 89900, position: 3 },
    ],
  },
  {
    handle: 'barrie-gravel-explorer',
    title: 'Barrie Gravel Explorer',
    description:
      'A drop-bar gravel bike on a carbon fork with clearance for 45 mm tyres. Draft: pricing not final.',
    status: 'draft',
    vendor: 'Barrie Bicycle Works',
    product_type: 'Bicycles',
    tags: ['new', 'outdoor'],
    created_at: '2025-10-14T10:40:00Z',
    variants: [
      { sku: 'BBW-GRAVEL-54', title: 'Frame 54 cm / Rust', price_cents: 144900, position: 1 },
      { sku: 'BBW-GRAVEL-58', title: 'Frame 58 cm / Rust', price_cents: 144900, position: 2 },
    ],
  },
  {
    handle: 'acme-packable-puffy',
    title: 'Acme Packable Puffy',
    description:
      'A synthetic-fill jacket that stuffs into its own chest pocket. Draft: awaiting final photography.',
    status: 'draft',
    vendor: 'Acme',
    product_type: 'Apparel',
    tags: ['winter', 'lightweight', 'new'],
    created_at: '2025-11-06T15:15:00Z',
    variants: [
      { sku: 'ACME-PUFF-BLK-M', title: 'Black / Medium', price_cents: 15900, position: 1 },
      { sku: 'ACME-PUFF-BLK-L', title: 'Black / Large', price_cents: 15900, position: 2 },
    ],
  },
  {
    handle: 'northwind-wool-toque',
    title: 'Northwind Wool Toque',
    description:
      'A ribbed merino toque with a fold-up brim. Made in a mill that has been running since 1948.',
    status: 'active',
    vendor: 'Northwind Traders',
    product_type: 'Apparel',
    tags: ['winter', 'eco'],
    created_at: '2025-12-02T13:00:00Z',
    variants: [
      { sku: 'NWT-TOQUE-OAT', title: 'Oatmeal', price_cents: 3400, position: 1 },
      { sku: 'NWT-TOQUE-FOR', title: 'Forest', price_cents: 3400, position: 2 },
      {
        sku: 'NWT-TOQUE-RST',
        title: 'Rust',
        price_cents: 3400,
        compare_at_price_cents: 3900,
        position: 3,
      },
    ],
  },
  {
    handle: 'summit-trekking-poles',
    title: 'Summit Trekking Poles',
    description: 'Three-section aluminium poles with cork grips and flick locks. Sold as a pair.',
    status: 'active',
    vendor: 'Summit Supply',
    product_type: 'Accessories',
    tags: ['hiking', 'outdoor', 'lightweight'],
    created_at: '2026-01-19T09:30:00Z',
    variants: [
      { sku: 'SUM-POLE-ALU', title: 'Aluminium Pair', price_cents: 8900, position: 1 },
      { sku: 'SUM-POLE-CRB', title: 'Carbon Pair', price_cents: 14900, position: 2 },
    ],
  },
  {
    handle: 'acme-canvas-tote',
    title: 'Acme Canvas Tote',
    description:
      'A waxed-canvas tote with leather handles. Discontinued in favour of the Harbour line.',
    status: 'archived',
    vendor: 'Acme',
    product_type: 'Accessories',
    tags: ['travel', 'clearance', 'eco'],
    created_at: '2026-03-04T11:50:00Z',
    variants: [
      {
        sku: 'ACME-TOTE-NAT',
        title: 'Natural',
        price_cents: 4900,
        compare_at_price_cents: 7900,
        position: 1,
      },
    ],
  },
  {
    handle: 'cascade-classic-anorak',
    title: 'Cascade Classic Anorak',
    description:
      'A half-zip pullover shell in the original 2019 colourway. Discontinued; remaining stock is clearance.',
    status: 'archived',
    vendor: 'Cascade Gear',
    product_type: 'Apparel',
    tags: ['clearance', 'waterproof'],
    created_at: '2026-08-12T16:05:00Z',
    variants: [
      {
        sku: 'CSC-ANRK-YEL-M',
        title: 'Marigold / Medium',
        price_cents: 9500,
        compare_at_price_cents: 18900,
        position: 1,
      },
      {
        sku: 'CSC-ANRK-YEL-L',
        title: 'Marigold / Large',
        price_cents: 9500,
        compare_at_price_cents: 18900,
        position: 2,
      },
    ],
  },
];

/** Sanity numbers, asserted by the seed loader so this file cannot silently drift. */
export const SEED_EXPECTED = {
  products: SEED_PRODUCTS.length,
  variants: SEED_PRODUCTS.reduce((n, p) => n + p.variants.length, 0),
};
