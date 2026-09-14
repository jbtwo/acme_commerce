import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { AppDatabase } from '../../db/index.js';
import { toCount } from '../../db/index.js';
import type { Database, LocationRow, LocationUpdate, NewLocationRow } from '../../db/schema.js';
import { escapeLikePattern } from '../catalog/repository.js';
import type { LOCATION_SORT_FIELDS } from './schemas.js';

export interface LocationFilters {
  type?: string | undefined;
  isActive?: boolean | undefined;
  q?: string | undefined;
}

function filters(
  eb: ExpressionBuilder<Database, 'locations'>,
  f: LocationFilters,
): Expression<SqlBool> {
  const conditions: Expression<SqlBool>[] = [];
  if (f.type) conditions.push(eb('type', '=', f.type as LocationRow['type']));
  if (f.isActive !== undefined) conditions.push(eb('is_active', '=', f.isActive));
  if (f.q) {
    const pattern = `%${escapeLikePattern(f.q)}%`;
    conditions.push(eb.or([eb('name', 'ilike', pattern), eb('city', 'ilike', pattern)]));
  }
  return conditions.length === 0 ? sql<SqlBool>`true` : eb.and(conditions);
}

export async function listLocations(
  db: AppDatabase,
  f: LocationFilters,
  sort: { field: (typeof LOCATION_SORT_FIELDS)[number]; direction: 'asc' | 'desc' },
  page: { page: number; limit: number },
): Promise<{ rows: LocationRow[]; total: number }> {
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const rows = await trx
        .selectFrom('locations')
        .selectAll()
        .where((eb) => filters(eb, f))
        .orderBy(sort.field, sort.direction)
        .orderBy('id', sort.direction)
        .limit(page.limit)
        .offset((page.page - 1) * page.limit)
        .execute();
      const counted = await trx
        .selectFrom('locations')
        .select(({ fn }) => fn.countAll().as('total'))
        .where((eb) => filters(eb, f))
        .executeTakeFirstOrThrow();
      return { rows, total: toCount(counted.total as string) };
    });
}

export async function findLocationById(
  db: AppDatabase,
  id: string,
): Promise<LocationRow | undefined> {
  return db.selectFrom('locations').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function findLocationByName(
  db: AppDatabase,
  name: string,
): Promise<LocationRow | undefined> {
  return db
    .selectFrom('locations')
    .selectAll()
    .where((eb) => eb(eb.fn('lower', ['name']), '=', name.trim().toLowerCase()))
    .executeTakeFirst();
}

export async function insertLocation(db: AppDatabase, row: NewLocationRow): Promise<LocationRow> {
  return db.insertInto('locations').values(row).returningAll().executeTakeFirstOrThrow();
}

export async function updateLocation(
  db: AppDatabase,
  id: string,
  patch: LocationUpdate,
): Promise<LocationRow | undefined> {
  return db
    .updateTable('locations')
    .set(patch)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}
