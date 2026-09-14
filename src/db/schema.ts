/**
 * The TypeScript description of the database schema that Kysely type-checks queries against.
 *
 * This file is hand-maintained and must be kept in step with the migrations in
 * src/db/migrations/. That is a real obligation, and it is the price of not running a
 * code-generation step. The payoff is that there is no generated artifact to be stale, no
 * codegen daemon, and the schema is readable in one screen.
 *
 * `ColumnType<Select, Insert, Update>` expresses that a column can behave differently in the
 * three positions. `created_at` is a good example: PostgreSQL always gives you a Date on
 * select, you may omit it on insert (the default fills it), and you must never set it on
 * update.
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** Set by a DEFAULT on insert, never written by the application on update. */
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
/** Maintained by a database trigger. The application never writes it. */
type UpdatedAt = ColumnType<Date, Date | string | undefined, never>;

export type ProductStatus = 'draft' | 'active' | 'archived';
export type VariantStatus = 'active' | 'archived';

export interface ProductsTable {
  id: string;
  title: string;
  description: string | null;
  status: Generated<ProductStatus>;
  vendor: string | null;
  product_type: string | null;
  tags: Generated<string[]>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  archived_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface VariantsTable {
  id: string;
  product_id: string;
  sku: string;
  title: string;
  /**
   * Money is an integer number of minor units — cents for CAD/USD. Never a float.
   * IEEE-754 doubles cannot represent 0.10 exactly, and money arithmetic in floats produces
   * off-by-a-cent errors that survive every test written by someone who did not expect them.
   */
  price_cents: number;
  compare_at_price_cents: number | null;
  currency: Generated<string>;
  barcode: string | null;
  /** Forward reference to the Inventory API in Milestone 2. Unused, and deliberately visible. */
  inventory_item_id: string | null;
  status: Generated<VariantStatus>;
  position: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  archived_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export type UserRole = 'developer' | 'support' | 'admin';
export type LocationType = 'warehouse' | 'retail' | 'virtual';

export interface UsersTable {
  id: string;
  email: string;
  name: string;
  /** scrypt$N$r$p$salt$hash. Never selected into anything that leaves the process. */
  password_hash: string;
  role: UserRole;
  is_active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface LocationsTable {
  id: string;
  name: string;
  type: LocationType;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  is_active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export type AdjustmentReason =
  'received' | 'sold' | 'damaged' | 'correction' | 'transfer_in' | 'transfer_out' | 'return';
export type ReservationStatus = 'active' | 'released' | 'expired';
export type PricingRuleType = 'sale' | 'customer_group' | 'quantity_break' | 'partner';
export type PricingScopeKind = 'all' | 'product_type' | 'sku';
export type PricingAdjustmentKind = 'percentage' | 'fixed_amount';

export interface InventoryItemsTable {
  id: string;
  sku: string;
  tracked: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface InventoryLevelsTable {
  id: string;
  inventory_item_id: string;
  location_id: string;
  /** Physically present. Never negative. */
  on_hand: Generated<number>;
  /**
   * Held by active reservations. Never negative, never above `on_hand`.
   * `available` is not a column — it is `on_hand - reserved`, computed at read time.
   */
  reserved: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface InventoryAdjustmentsTable {
  id: string;
  inventory_item_id: string;
  location_id: string;
  quantity_delta: number;
  reason: AdjustmentReason;
  reference: string | null;
  actor: string;
  created_at: CreatedAt;
}

export interface InventoryReservationsTable {
  id: string;
  inventory_item_id: string;
  location_id: string;
  quantity: number;
  status: Generated<ReservationStatus>;
  reference: string | null;
  actor: string;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  released_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface PricingRulesTable {
  id: string;
  name: string;
  type: PricingRuleType;
  scope_kind: Generated<PricingScopeKind>;
  scope_value: string | null;
  adjustment_kind: PricingAdjustmentKind;
  /** Basis points for `percentage` (-1500 = 15% off), minor units for `fixed_amount`. */
  adjustment_value: number;
  min_quantity: number | null;
  customer_group: string | null;
  partner_id: string | null;
  priority: Generated<number>;
  starts_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  ends_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  is_active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface Database {
  products: ProductsTable;
  variants: VariantsTable;
  users: UsersTable;
  locations: LocationsTable;
  inventory_items: InventoryItemsTable;
  inventory_levels: InventoryLevelsTable;
  inventory_adjustments: InventoryAdjustmentsTable;
  inventory_reservations: InventoryReservationsTable;
  pricing_rules: PricingRulesTable;
}

export type ProductRow = Selectable<ProductsTable>;
export type NewProductRow = Insertable<ProductsTable>;
export type ProductUpdate = Updateable<ProductsTable>;

export type UserRow = Selectable<UsersTable>;
export type NewUserRow = Insertable<UsersTable>;
export type LocationRow = Selectable<LocationsTable>;
export type NewLocationRow = Insertable<LocationsTable>;
export type LocationUpdate = Updateable<LocationsTable>;

export type InventoryItemRow = Selectable<InventoryItemsTable>;
export type NewInventoryItemRow = Insertable<InventoryItemsTable>;
export type InventoryLevelRow = Selectable<InventoryLevelsTable>;
export type NewInventoryLevelRow = Insertable<InventoryLevelsTable>;
export type InventoryAdjustmentRow = Selectable<InventoryAdjustmentsTable>;
export type NewInventoryAdjustmentRow = Insertable<InventoryAdjustmentsTable>;
export type InventoryReservationRow = Selectable<InventoryReservationsTable>;
export type NewInventoryReservationRow = Insertable<InventoryReservationsTable>;
export type PricingRuleRow = Selectable<PricingRulesTable>;
export type NewPricingRuleRow = Insertable<PricingRulesTable>;

export type VariantRow = Selectable<VariantsTable>;
export type NewVariantRow = Insertable<VariantsTable>;
export type VariantUpdate = Updateable<VariantsTable>;
