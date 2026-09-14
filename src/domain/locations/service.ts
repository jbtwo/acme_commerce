import {
  AppError,
  isPgError,
  MalformedIdError,
  NotFoundError,
  PG_ERROR,
} from '../../http/errors.js';
import type { AppDatabase } from '../../db/index.js';
import type { LocationRow } from '../../db/schema.js';
import { ID_PREFIXES, idPattern, idPatternString, locationId } from '../ids.js';
import * as repo from './repository.js';
import type {
  CreateLocationInput,
  LocationListQueryType,
  LocationResource,
  UpdateLocationInput,
} from './schemas.js';

const iso = (v: Date | string): string =>
  v instanceof Date ? v.toISOString() : new Date(v).toISOString();

export function toLocationResource(row: LocationRow): LocationResource {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    address_line1: row.address_line1,
    address_line2: row.address_line2,
    city: row.city,
    region: row.region,
    postal_code: row.postal_code,
    country: row.country,
    is_active: row.is_active,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export function assertLocationId(value: string): void {
  if (!idPattern(ID_PREFIXES.location).test(value)) {
    throw new MalformedIdError('locationId', value, idPatternString(ID_PREFIXES.location));
  }
}

const notFound = (id: string) =>
  new NotFoundError('LOCATION_NOT_FOUND', `No location exists with id "${id}".`, {
    location_id: id,
  });

/**
 * Name uniqueness is enforced by a unique index, and the violation is interpreted rather than
 * pre-checked — same reasoning as SKU uniqueness in the catalog. A SELECT-then-INSERT loses
 * the race between two concurrent creates and passes every single-threaded test.
 */
async function withNameConflict<T>(
  db: AppDatabase,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (
      isPgError(err, PG_ERROR.UNIQUE_VIOLATION) &&
      err.constraint === 'locations_name_lower_idx'
    ) {
      const existing = await repo.findLocationByName(db, name).catch(() => undefined);
      throw new AppError('LOCATION_NAME_EXISTS', `A location named "${name}" already exists.`, {
        details: {
          name,
          ...(existing ? { conflicting_location_id: existing.id } : {}),
          hint: 'Location names are unique, case-insensitively.',
        },
      });
    }
    throw err;
  }
}

export async function listLocations(db: AppDatabase, query: LocationListQueryType) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 25;
  const result = await repo.listLocations(
    db,
    { type: query.type, isActive: query.is_active, q: query.q },
    { field: query.sort ?? 'name', direction: query.order ?? 'asc' },
    { page, limit },
  );
  return { locations: result.rows.map(toLocationResource), page, limit, total: result.total };
}

export async function getLocation(db: AppDatabase, id: string): Promise<LocationResource> {
  assertLocationId(id);
  const row = await repo.findLocationById(db, id);
  if (!row) throw notFound(id);
  return toLocationResource(row);
}

export async function createLocation(
  db: AppDatabase,
  input: CreateLocationInput,
): Promise<LocationResource> {
  const row = await withNameConflict(db, input.name, () =>
    repo.insertLocation(db, {
      id: locationId(),
      name: input.name,
      type: input.type,
      address_line1: input.address_line1 ?? null,
      address_line2: input.address_line2 ?? null,
      city: input.city ?? null,
      region: input.region ?? null,
      postal_code: input.postal_code ?? null,
      country: input.country ?? null,
      is_active: input.is_active ?? true,
    }),
  );
  return toLocationResource(row);
}

export async function patchLocation(
  db: AppDatabase,
  id: string,
  input: UpdateLocationInput,
): Promise<LocationResource> {
  assertLocationId(id);
  const existing = await repo.findLocationById(db, id);
  if (!existing) throw notFound(id);

  const patch: Parameters<typeof repo.updateLocation>[2] = {};
  if ('name' in input) patch.name = input.name;
  if ('type' in input) patch.type = input.type;
  if ('address_line1' in input) patch.address_line1 = input.address_line1 ?? null;
  if ('address_line2' in input) patch.address_line2 = input.address_line2 ?? null;
  if ('city' in input) patch.city = input.city ?? null;
  if ('region' in input) patch.region = input.region ?? null;
  if ('postal_code' in input) patch.postal_code = input.postal_code ?? null;
  if ('country' in input) patch.country = input.country ?? null;
  if ('is_active' in input) patch.is_active = input.is_active;

  if (Object.keys(patch).length === 0) return toLocationResource(existing);

  const updated = await withNameConflict(db, input.name ?? existing.name, () =>
    repo.updateLocation(db, id, patch),
  );
  if (!updated) throw notFound(id);
  return toLocationResource(updated);
}
