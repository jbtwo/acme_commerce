/**
 * Inventory data access.
 *
 * The reservation and adjustment paths are the interesting ones: both write through database
 * constraints rather than checking first, so two concurrent callers cannot both succeed at
 * taking the last unit.
 */
import {
  sql,
  type Expression,
  type ExpressionBuilder,
  type SqlBool,
  type Transaction,
} from 'kysely';
import type { AppDatabase } from '../../db/index.js';
import { toCount } from '../../db/index.js';
import type {
  AdjustmentReason,
  Database,
  InventoryAdjustmentRow,
  InventoryLevelRow,
  InventoryReservationRow,
} from '../../db/schema.js';
import { inventoryAdjustmentId, inventoryLevelId, inventoryReservationId } from '../ids.js';

/** A level joined to the things a caller actually wants to see. */
export interface LevelWithContext {
  id: string;
  inventory_item_id: string;
  sku: string;
  location_id: string;
  location_name: string;
  on_hand: number;
  reserved: number;
  updated_at: Date;
}

type Trx = Transaction<Database>;

export interface LevelFilters {
  sku?: string | undefined;
  locationId?: string | undefined;
  /** Match levels whose computed availability is strictly below this. */
  availableBelow?: number | undefined;
}

function levelFilters(
  eb: ExpressionBuilder<Database, 'inventory_levels' | 'inventory_items' | 'locations'>,
  f: LevelFilters,
): Expression<SqlBool> {
  const conditions: Expression<SqlBool>[] = [];
  if (f.sku) conditions.push(eb('inventory_items.sku', '=', f.sku));
  if (f.locationId) conditions.push(eb('inventory_levels.location_id', '=', f.locationId));
  if (f.availableBelow !== undefined) {
    // Availability is computed, never stored — so it is filtered on as an expression.
    conditions.push(
      sql<SqlBool>`(inventory_levels.on_hand - inventory_levels.reserved) < ${f.availableBelow}`,
    );
  }
  return conditions.length === 0 ? sql<SqlBool>`true` : eb.and(conditions);
}

export async function listLevels(
  db: AppDatabase,
  f: LevelFilters,
  sort: { field: 'sku' | 'available' | 'on_hand' | 'updated_at'; direction: 'asc' | 'desc' },
  page: { page: number; limit: number },
): Promise<{ rows: LevelWithContext[]; total: number }> {
  const orderBy =
    sort.field === 'available'
      ? sql`(inventory_levels.on_hand - inventory_levels.reserved)`
      : sort.field === 'sku'
        ? sql`inventory_items.sku`
        : sort.field === 'on_hand'
          ? sql`inventory_levels.on_hand`
          : sql`inventory_levels.updated_at`;

  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const rows = (await trx
        .selectFrom('inventory_levels')
        .innerJoin('inventory_items', 'inventory_items.id', 'inventory_levels.inventory_item_id')
        .innerJoin('locations', 'locations.id', 'inventory_levels.location_id')
        .select([
          'inventory_levels.id as id',
          'inventory_levels.inventory_item_id as inventory_item_id',
          'inventory_items.sku as sku',
          'inventory_levels.location_id as location_id',
          'locations.name as location_name',
          'inventory_levels.on_hand as on_hand',
          'inventory_levels.reserved as reserved',
          'inventory_levels.updated_at as updated_at',
        ])
        .where((eb) => levelFilters(eb, f))
        .orderBy(orderBy, sort.direction)
        .orderBy('inventory_levels.id', sort.direction)
        .limit(page.limit)
        .offset((page.page - 1) * page.limit)
        .execute()) as unknown as LevelWithContext[];

      const counted = await trx
        .selectFrom('inventory_levels')
        .innerJoin('inventory_items', 'inventory_items.id', 'inventory_levels.inventory_item_id')
        .innerJoin('locations', 'locations.id', 'inventory_levels.location_id')
        .select(({ fn }) => fn.countAll().as('total'))
        .where((eb) => levelFilters(eb, f))
        .executeTakeFirstOrThrow();

      return { rows, total: toCount(counted.total as string) };
    });
}

export async function findItemBySku(db: AppDatabase | Trx, sku: string) {
  return db.selectFrom('inventory_items').selectAll().where('sku', '=', sku).executeTakeFirst();
}

export async function variantExists(db: AppDatabase, sku: string): Promise<boolean> {
  const row = await db
    .selectFrom('variants')
    .select('sku')
    .where('sku', '=', sku)
    .executeTakeFirst();
  return row !== undefined;
}

export async function levelsForSku(db: AppDatabase, sku: string): Promise<LevelWithContext[]> {
  return (await db
    .selectFrom('inventory_levels')
    .innerJoin('inventory_items', 'inventory_items.id', 'inventory_levels.inventory_item_id')
    .innerJoin('locations', 'locations.id', 'inventory_levels.location_id')
    .select([
      'inventory_levels.id as id',
      'inventory_levels.inventory_item_id as inventory_item_id',
      'inventory_items.sku as sku',
      'inventory_levels.location_id as location_id',
      'locations.name as location_name',
      'inventory_levels.on_hand as on_hand',
      'inventory_levels.reserved as reserved',
      'inventory_levels.updated_at as updated_at',
    ])
    .where('inventory_items.sku', '=', sku)
    .orderBy('locations.name', 'asc')
    .execute()) as unknown as LevelWithContext[];
}

/**
 * Release every active reservation for one item and location whose expiry has passed,
 * returning the stock they were holding.
 *
 * Called at the start of every reservation attempt, inside the same transaction. Without it,
 * `reserved` stays inflated by reservations nobody will ever release, and the
 * `reserved <= on_hand` constraint eventually starts refusing reservations for stock that is
 * genuinely free — a failure that no concurrency test would catch, because the data only
 * becomes wrong with the passage of time.
 */
export async function sweepExpired(
  trx: Trx,
  inventoryItemId: string,
  locationId: string,
  now: Date,
): Promise<number> {
  const expired = await trx
    .updateTable('inventory_reservations')
    .set({ status: 'expired', released_at: now })
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', locationId)
    .where('status', '=', 'active')
    .where('expires_at', '<=', now)
    .returning('quantity')
    .execute();

  const total = expired.reduce((sum, r) => sum + r.quantity, 0);
  if (total > 0) {
    await trx
      .updateTable('inventory_levels')
      .set((eb) => ({ reserved: eb('reserved', '-', total) }))
      .where('inventory_item_id', '=', inventoryItemId)
      .where('location_id', '=', locationId)
      .execute();
  }
  return total;
}

export async function findLevel(
  trx: Trx,
  inventoryItemId: string,
  locationId: string,
): Promise<InventoryLevelRow | undefined> {
  return trx
    .selectFrom('inventory_levels')
    .selectAll()
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', locationId)
    .executeTakeFirst();
}

/** Create the level row if this is the first stock at this location. */
export async function ensureLevel(
  trx: Trx,
  inventoryItemId: string,
  locationId: string,
): Promise<InventoryLevelRow> {
  const existing = await findLevel(trx, inventoryItemId, locationId);
  if (existing) return existing;
  return trx
    .insertInto('inventory_levels')
    .values({
      id: inventoryLevelId(),
      inventory_item_id: inventoryItemId,
      location_id: locationId,
      on_hand: 0,
      reserved: 0,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function applyDelta(
  trx: Trx,
  inventoryItemId: string,
  locationId: string,
  delta: number,
): Promise<InventoryLevelRow> {
  return trx
    .updateTable('inventory_levels')
    .set((eb) => ({ on_hand: eb('on_hand', '+', delta) }))
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', locationId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function insertAdjustment(
  trx: Trx,
  row: {
    inventoryItemId: string;
    locationId: string;
    delta: number;
    reason: AdjustmentReason;
    reference: string | null;
    actor: string;
  },
): Promise<InventoryAdjustmentRow> {
  return trx
    .insertInto('inventory_adjustments')
    .values({
      id: inventoryAdjustmentId(),
      inventory_item_id: row.inventoryItemId,
      location_id: row.locationId,
      quantity_delta: row.delta,
      reason: row.reason,
      reference: row.reference,
      actor: row.actor,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function addReserved(
  trx: Trx,
  inventoryItemId: string,
  locationId: string,
  quantity: number,
): Promise<InventoryLevelRow> {
  return trx
    .updateTable('inventory_levels')
    .set((eb) => ({ reserved: eb('reserved', '+', quantity) }))
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', locationId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function insertReservation(
  trx: Trx,
  row: {
    inventoryItemId: string;
    locationId: string;
    quantity: number;
    reference: string | null;
    actor: string;
    expiresAt: Date;
  },
): Promise<InventoryReservationRow> {
  return trx
    .insertInto('inventory_reservations')
    .values({
      id: inventoryReservationId(),
      inventory_item_id: row.inventoryItemId,
      location_id: row.locationId,
      quantity: row.quantity,
      status: 'active',
      reference: row.reference,
      actor: row.actor,
      expires_at: row.expiresAt,
      released_at: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function findReservation(
  db: AppDatabase | Trx,
  id: string,
): Promise<InventoryReservationRow | undefined> {
  return db
    .selectFrom('inventory_reservations')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
}

export async function markReleased(
  trx: Trx,
  id: string,
  now: Date,
): Promise<InventoryReservationRow | undefined> {
  return trx
    .updateTable('inventory_reservations')
    .set({ status: 'released', released_at: now })
    .where('id', '=', id)
    .where('status', '=', 'active')
    .returningAll()
    .executeTakeFirst();
}

export interface HistoryFilters {
  sku?: string | undefined;
  locationId?: string | undefined;
  reason?: AdjustmentReason | undefined;
  createdAfter?: Date | undefined;
  createdBefore?: Date | undefined;
}

export interface AdjustmentWithContext extends InventoryAdjustmentRow {
  sku: string;
  location_name: string;
}

export async function listAdjustments(
  db: AppDatabase,
  f: HistoryFilters,
  page: { page: number; limit: number },
): Promise<{ rows: AdjustmentWithContext[]; total: number }> {
  const where = (
    eb: ExpressionBuilder<Database, 'inventory_adjustments' | 'inventory_items' | 'locations'>,
  ): Expression<SqlBool> => {
    const c: Expression<SqlBool>[] = [];
    if (f.sku) c.push(eb('inventory_items.sku', '=', f.sku));
    if (f.locationId) c.push(eb('inventory_adjustments.location_id', '=', f.locationId));
    if (f.reason) c.push(eb('inventory_adjustments.reason', '=', f.reason));
    if (f.createdAfter) c.push(eb('inventory_adjustments.created_at', '>=', f.createdAfter));
    if (f.createdBefore) c.push(eb('inventory_adjustments.created_at', '<=', f.createdBefore));
    return c.length === 0 ? sql<SqlBool>`true` : eb.and(c);
  };

  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const rows = (await trx
        .selectFrom('inventory_adjustments')
        .innerJoin(
          'inventory_items',
          'inventory_items.id',
          'inventory_adjustments.inventory_item_id',
        )
        .innerJoin('locations', 'locations.id', 'inventory_adjustments.location_id')
        .selectAll('inventory_adjustments')
        .select(['inventory_items.sku as sku', 'locations.name as location_name'])
        .where(where)
        .orderBy('inventory_adjustments.created_at', 'desc')
        .orderBy('inventory_adjustments.id', 'desc')
        .limit(page.limit)
        .offset((page.page - 1) * page.limit)
        .execute()) as unknown as AdjustmentWithContext[];

      const counted = await trx
        .selectFrom('inventory_adjustments')
        .innerJoin(
          'inventory_items',
          'inventory_items.id',
          'inventory_adjustments.inventory_item_id',
        )
        .innerJoin('locations', 'locations.id', 'inventory_adjustments.location_id')
        .select(({ fn }) => fn.countAll().as('total'))
        .where(where)
        .executeTakeFirstOrThrow();

      return { rows, total: toCount(counted.total as string) };
    });
}
