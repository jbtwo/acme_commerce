import type { AppDatabase } from '../../db/index.js';
import type { UserRow } from '../../db/schema.js';

/** Case-insensitive lookup — `Dev@acme.example` and `dev@acme.example` are one account. */
export async function findUserByEmail(
  db: AppDatabase,
  email: string,
): Promise<UserRow | undefined> {
  return db
    .selectFrom('users')
    .selectAll()
    .where((eb) => eb(eb.fn('lower', ['email']), '=', email.trim().toLowerCase()))
    .executeTakeFirst();
}

export async function findUserById(db: AppDatabase, id: string): Promise<UserRow | undefined> {
  return db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
}
