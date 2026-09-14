/**
 * Inventory business logic.
 *
 * Two rules carry this whole domain:
 *
 *   1. `available` is derived, never stored. `on_hand - reserved`, computed on read.
 *   2. Stock movements are attempted and their failures interpreted, never pre-checked.
 *      A read-check-write loses the race for the last unit, and loses it only under
 *      concurrency, which is to say only in production.
 */
import { AppError, isPgError, NotFoundError, PG_ERROR } from '../../http/errors.js';
import type { AppDatabase } from '../../db/index.js';
import type { AdjustmentReason, InventoryReservationRow } from '../../db/schema.js';
import * as repo from './repository.js';
import { assertLocationId } from '../locations/service.js';
import * as locationRepo from '../locations/repository.js';
import { ID_PREFIXES, idPattern, idPatternString } from '../ids.js';
import { MalformedIdError } from '../../http/errors.js';

/**
 * Marker thrown from inside a transaction when a stock constraint refuses a write.
 *
 * PostgreSQL aborts the whole transaction on a failed statement — every subsequent query in it
 * errors with "current transaction is aborted" until rollback. So the constraint violation
 * cannot be turned into a useful error *inside* the transaction that caused it: reading the
 * current level to report `available` would itself fail, and the caller would get a 500 where
 * a 409 was intended.
 *
 * The transaction therefore throws this marker, unwinds, and the authoritative numbers are
 * read afterwards on a clean connection.
 */
class StockConstraintViolation extends Error {
  constructor(readonly constraintName: string | undefined) {
    super('stock constraint violated');
    this.name = 'StockConstraintViolation';
  }
}

export const DEFAULT_RESERVATION_TTL_SECONDS = 900; // 15 minutes
export const MAX_RESERVATION_TTL_SECONDS = 86_400;

export interface LevelResource {
  sku: string;
  location_id: string;
  location_name: string;
  on_hand: number;
  reserved: number;
  available: number;
  updated_at: string;
}

const iso = (v: Date | string): string =>
  v instanceof Date ? v.toISOString() : new Date(v).toISOString();

function toLevel(row: repo.LevelWithContext): LevelResource {
  return {
    sku: row.sku,
    location_id: row.location_id,
    location_name: row.location_name,
    on_hand: row.on_hand,
    reserved: row.reserved,
    // Computed here and nowhere else. There is no `available` column to drift.
    available: row.on_hand - row.reserved,
    updated_at: iso(row.updated_at),
  };
}

export function assertReservationId(value: string): void {
  if (!idPattern(ID_PREFIXES.inventoryReservation).test(value)) {
    throw new MalformedIdError(
      'reservationId',
      value,
      idPatternString(ID_PREFIXES.inventoryReservation),
    );
  }
}

/**
 * Resolve a SKU to its inventory item, distinguishing the two ways it can be missing.
 *
 * They need different fixes: an unknown SKU is a typo, while a known SKU with no inventory
 * item means the catalog and inventory have diverged and somebody has to create the item.
 * Collapsing both into one 404 sends people hunting for a typo that isn't there.
 */
async function resolveItem(db: AppDatabase, sku: string) {
  const item = await repo.findItemBySku(db, sku);
  if (item) return item;

  if (await repo.variantExists(db, sku)) {
    throw new NotFoundError(
      'INVENTORY_ITEM_NOT_FOUND',
      `SKU "${sku}" exists in the catalog but is not inventory-tracked.`,
      { sku, hint: 'The variant is real; no inventory item has been created for it.' },
    );
  }
  throw new NotFoundError('VARIANT_NOT_FOUND', `No variant exists with SKU "${sku}".`, {
    sku,
    hint: 'Check the SKU. Inventory is addressed by SKU rather than by variant id.',
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listInventory(
  db: AppDatabase,
  query: {
    page?: number;
    limit?: number;
    sku?: string;
    location_id?: string;
    available_below?: number;
    sort?: 'sku' | 'available' | 'on_hand' | 'updated_at';
    order?: 'asc' | 'desc';
  },
) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 25;
  if (query.location_id) assertLocationId(query.location_id);

  const result = await repo.listLevels(
    db,
    { sku: query.sku, locationId: query.location_id, availableBelow: query.available_below },
    { field: query.sort ?? 'sku', direction: query.order ?? 'asc' },
    { page, limit },
  );
  return { levels: result.rows.map(toLevel), page, limit, total: result.total };
}

export interface SkuInventory {
  sku: string;
  tracked: boolean;
  totals: { on_hand: number; reserved: number; available: number };
  locations: LevelResource[];
}

export async function getInventoryForSku(db: AppDatabase, sku: string): Promise<SkuInventory> {
  const item = await resolveItem(db, sku);
  const rows = await repo.levelsForSku(db, sku);
  const locations = rows.map(toLevel);
  return {
    sku,
    tracked: item.tracked,
    totals: {
      on_hand: locations.reduce((n, l) => n + l.on_hand, 0),
      reserved: locations.reduce((n, l) => n + l.reserved, 0),
      available: locations.reduce((n, l) => n + l.available, 0),
    },
    locations,
  };
}

export async function listHistory(
  db: AppDatabase,
  query: {
    page?: number;
    limit?: number;
    sku?: string;
    location_id?: string;
    reason?: AdjustmentReason;
    created_after?: string;
    created_before?: string;
  },
) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 25;
  if (query.location_id) assertLocationId(query.location_id);

  const result = await repo.listAdjustments(
    db,
    {
      sku: query.sku,
      locationId: query.location_id,
      reason: query.reason,
      createdAfter: query.created_after ? new Date(query.created_after) : undefined,
      createdBefore: query.created_before ? new Date(query.created_before) : undefined,
    },
    { page, limit },
  );

  return {
    adjustments: result.rows.map((a) => ({
      id: a.id,
      sku: a.sku,
      location_id: a.location_id,
      location_name: a.location_name,
      quantity_delta: a.quantity_delta,
      reason: a.reason,
      reference: a.reference,
      actor: a.actor,
      created_at: iso(a.created_at),
    })),
    page,
    limit,
    total: result.total,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function assertLocationExists(db: AppDatabase, locationId: string): Promise<string> {
  assertLocationId(locationId);
  const loc = await locationRepo.findLocationById(db, locationId);
  if (!loc) {
    throw new NotFoundError('LOCATION_NOT_FOUND', `No location exists with id "${locationId}".`, {
      location_id: locationId,
    });
  }
  return loc.name;
}

export async function adjustInventory(
  db: AppDatabase,
  input: {
    sku: string;
    location_id: string;
    quantity_delta: number;
    reason: AdjustmentReason;
    reference?: string | null;
  },
  actor: string,
) {
  const item = await resolveItem(db, input.sku);
  await assertLocationExists(db, input.location_id);

  try {
    return await db.transaction().execute(async (trx) => {
      await repo.ensureLevel(trx, item.id, input.location_id);

      let level;
      try {
        level = await repo.applyDelta(trx, item.id, input.location_id, input.quantity_delta);
      } catch (err) {
        if (isPgError(err, PG_ERROR.CHECK_VIOLATION))
          throw new StockConstraintViolation(err.constraint);
        throw err;
      }

      const adjustment = await repo.insertAdjustment(trx, {
        inventoryItemId: item.id,
        locationId: input.location_id,
        delta: input.quantity_delta,
        reason: input.reason,
        reference: input.reference ?? null,
        actor,
      });

      return {
        adjustment: {
          id: adjustment.id,
          sku: input.sku,
          location_id: input.location_id,
          quantity_delta: adjustment.quantity_delta,
          reason: adjustment.reason,
          reference: adjustment.reference,
          actor: adjustment.actor,
          created_at: iso(adjustment.created_at),
        },
        level: {
          sku: input.sku,
          location_id: input.location_id,
          on_hand: level.on_hand,
          reserved: level.reserved,
          available: level.on_hand - level.reserved,
        },
      };
    });
  } catch (err) {
    if (!(err instanceof StockConstraintViolation)) throw err;

    // Fresh read, after the failed transaction has rolled back.
    const current = await currentLevel(db, item.id, input.location_id);
    const projected = current.on_hand + input.quantity_delta;
    throw new AppError(
      'INVENTORY_INSUFFICIENT',
      err.constraintName === 'inventory_levels_not_oversold'
        ? `Reducing on-hand stock to ${projected} would leave less than the ${current.reserved} already reserved.`
        : `Cannot reduce on-hand stock below zero. ${current.on_hand} is currently on hand.`,
      {
        details: {
          sku: input.sku,
          location_id: input.location_id,
          on_hand: current.on_hand,
          reserved: current.reserved,
          available: current.on_hand - current.reserved,
          requested_delta: input.quantity_delta,
        },
      },
    );
  }
}

/** Read a level outside any transaction, for reporting after one has rolled back. */
async function currentLevel(
  db: AppDatabase,
  inventoryItemId: string,
  locationId: string,
): Promise<{ on_hand: number; reserved: number }> {
  const row = await db
    .selectFrom('inventory_levels')
    .select(['on_hand', 'reserved'])
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', locationId)
    .executeTakeFirst();
  return { on_hand: row?.on_hand ?? 0, reserved: row?.reserved ?? 0 };
}

export interface ReservationResource {
  id: string;
  sku: string;
  location_id: string;
  quantity: number;
  status: 'active' | 'released' | 'expired';
  reference: string | null;
  actor: string;
  expires_at: string;
  released_at: string | null;
  created_at: string;
}

function toReservation(row: InventoryReservationRow, sku: string): ReservationResource {
  return {
    id: row.id,
    sku,
    location_id: row.location_id,
    quantity: row.quantity,
    status: row.status,
    reference: row.reference,
    actor: row.actor,
    expires_at: iso(row.expires_at),
    released_at: row.released_at ? iso(row.released_at) : null,
    created_at: iso(row.created_at),
  };
}

export async function createReservation(
  db: AppDatabase,
  input: {
    sku: string;
    location_id: string;
    quantity: number;
    reference?: string | null;
    ttl_seconds?: number;
  },
  actor: string,
): Promise<ReservationResource> {
  const item = await resolveItem(db, input.sku);
  await assertLocationExists(db, input.location_id);
  const ttl = input.ttl_seconds ?? DEFAULT_RESERVATION_TTL_SECONDS;

  try {
    return await db.transaction().execute(async (trx) => {
      const now = new Date();

      await repo.ensureLevel(trx, item.id, input.location_id);
      // Reclaim anything that has quietly expired here before deciding whether there is room.
      // Without this the constraint below would refuse reservations for stock that is free.
      await repo.sweepExpired(trx, item.id, input.location_id, now);

      try {
        await repo.addReserved(trx, item.id, input.location_id, input.quantity);
      } catch (err) {
        if (
          isPgError(err, PG_ERROR.CHECK_VIOLATION) &&
          err.constraint === 'inventory_levels_not_oversold'
        ) {
          throw new StockConstraintViolation(err.constraint);
        }
        throw err;
      }

      const reservation = await repo.insertReservation(trx, {
        inventoryItemId: item.id,
        locationId: input.location_id,
        quantity: input.quantity,
        reference: input.reference ?? null,
        actor,
        expiresAt: new Date(now.getTime() + ttl * 1000),
      });
      return toReservation(reservation, input.sku);
    });
  } catch (err) {
    if (!(err instanceof StockConstraintViolation)) throw err;

    // The database refused it — someone else got there first, or there was never enough.
    // Either way the answer is the same, and read after rollback it is authoritative.
    const current = await currentLevel(db, item.id, input.location_id);
    const available = current.on_hand - current.reserved;
    throw new AppError(
      'INVENTORY_INSUFFICIENT',
      `Only ${available} of SKU "${input.sku}" is available at that location; ${input.quantity} was requested.`,
      {
        details: {
          sku: input.sku,
          location_id: input.location_id,
          requested: input.quantity,
          available,
          on_hand: current.on_hand,
          reserved: current.reserved,
        },
      },
    );
  }
}

export async function getReservation(db: AppDatabase, id: string): Promise<ReservationResource> {
  assertReservationId(id);
  const row = await repo.findReservation(db, id);
  if (!row) {
    throw new NotFoundError('RESERVATION_NOT_FOUND', `No reservation exists with id "${id}".`, {
      reservation_id: id,
    });
  }
  const item = await db
    .selectFrom('inventory_items')
    .select('sku')
    .where('id', '=', row.inventory_item_id)
    .executeTakeFirstOrThrow();

  // Reported as expired the moment its expiry has passed, even though the sweep that actually
  // frees the stock has not run yet. Telling a caller a reservation is still active when it
  // has demonstrably lapsed would be a worse lie than the momentary inconsistency in
  // `reserved`.
  if (row.status === 'active' && row.expires_at.getTime() <= Date.now()) {
    return { ...toReservation(row, item.sku), status: 'expired' };
  }
  return toReservation(row, item.sku);
}

/**
 * Release a reservation and return the stock.
 *
 * Idempotent: releasing an already-released reservation returns `200` with the reservation
 * unchanged, for the same reasons archiving a product twice does. "Make sure this is released"
 * is a reasonable thing to say twice, particularly after a network timeout.
 *
 * An *expired* reservation is a different case and returns `409` — its stock was already
 * reclaimed by the sweep, so there is nothing to release, and silently succeeding would let a
 * caller believe they had returned stock they had not.
 */
export async function releaseReservation(
  db: AppDatabase,
  id: string,
): Promise<ReservationResource> {
  assertReservationId(id);

  return db.transaction().execute(async (trx) => {
    const existing = await repo.findReservation(trx, id);
    if (!existing) {
      throw new NotFoundError('RESERVATION_NOT_FOUND', `No reservation exists with id "${id}".`, {
        reservation_id: id,
      });
    }

    const item = await trx
      .selectFrom('inventory_items')
      .select('sku')
      .where('id', '=', existing.inventory_item_id)
      .executeTakeFirstOrThrow();

    if (existing.status === 'released') return toReservation(existing, item.sku);

    if (existing.status === 'expired') {
      throw new AppError(
        'RESERVATION_NOT_ACTIVE',
        'That reservation expired and its stock has already been returned.',
        {
          details: {
            reservation_id: id,
            status: 'expired',
            expires_at: iso(existing.expires_at),
            hint: 'Nothing to release. Create a new reservation if you still need the stock.',
          },
        },
      );
    }

    const now = new Date();
    const released = await repo.markReleased(trx, id, now);
    if (!released) {
      // Lost a race with a concurrent release; the other one won and the state is correct.
      const current = await repo.findReservation(trx, id);
      return toReservation(current!, item.sku);
    }

    await trx
      .updateTable('inventory_levels')
      .set((eb) => ({ reserved: eb('reserved', '-', existing.quantity) }))
      .where('inventory_item_id', '=', existing.inventory_item_id)
      .where('location_id', '=', existing.location_id)
      .execute();

    return toReservation(released, item.sku);
  });
}
