# PostgreSQL setup

Acme Commerce **connects to** a PostgreSQL instance. It never creates one, never configures the
server, and never assumes superuser access. This document covers what you create _inside_ an
existing PostgreSQL server so the application can use it.

Every credential below is a placeholder. Replace anything in `REPLACE_*` form.

> **Local development:** `./scripts/dev-postgres.sh` performs everything in §2 against a
> throwaway container on your own machine, then writes the connection strings into `.env`. That
> script runs the same SQL documented here — including the application role _not_ being a
> superuser — so the privilege model you develop against is the one you deploy against. It has
> no role in deployment. See [D-021](DECISIONS.md#d-021).

---

## 1. What the application needs

| Requirement    | Detail                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| Server version | PostgreSQL 15 or newer. Verified against 17.11.                                                           |
| Extensions     | **None.** Deliberately, because `CREATE EXTENSION` needs elevated privileges.                             |
| Superuser      | **Not required, and not wanted.**                                                                         |
| Databases      | One for the application. A second, separate one if you want to run integration tests against this server. |
| Schema         | The application creates and owns a schema (default `acme`) inside its own database.                       |
| Encoding       | UTF-8.                                                                                                    |

The application will create, inside its own schema: two tables (`products`, `variants`), two
Kysely migration-tracking tables, seven indexes, one trigger function, and two triggers. It
touches nothing outside that schema.

---

## 2. Creating the role and databases

Run these as a user that can create roles and databases — the `postgres` superuser, or any role
with `CREATEROLE` and `CREATEDB`.

### 2.1 The application role

```sql
-- Choose a long random password. A password manager is the right tool; so is:
--   openssl rand -base64 32
CREATE ROLE acme_app WITH LOGIN PASSWORD 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';
```

Note what is **absent**: no `SUPERUSER`, no `CREATEDB`, no `CREATEROLE`, no `REPLICATION`. The
role can log in and own the objects it is given, and nothing else. If this credential ever
leaks, the damage is bounded by that.

### 2.2 The application database

```sql
CREATE DATABASE acme_commerce
  OWNER    acme_app
  ENCODING 'UTF8';
```

`OWNER acme_app` is doing real work. Since PostgreSQL 15, a database's `public` schema is owned
by the pseudo-role `pg_database_owner`, so making `acme_app` the database owner makes it the
effective owner of that database's schemas — enough to create the `acme` schema and everything
in it, with **no further grants**.

Confirm it:

```sql
\c acme_commerce
SELECT current_user,
       (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') AS public_owner;
-- expect: acme_app | pg_database_owner
```

### 2.3 A separate test database (optional but recommended)

Only needed if you want to run `npm run test:integration` against this server. The name **must**
contain `test` — the safety guard in `src/db/guard.ts` refuses to touch a database whose name
does not match `test_*`, `*_test`, or `*_test_*`.

```sql
CREATE DATABASE acme_commerce_test
  OWNER    acme_app
  ENCODING 'UTF8';
```

### 2.4 If you cannot own the database

Some managed PostgreSQL services will not let you set an arbitrary database owner. In that case
grant the schema explicitly instead:

```sql
-- Run as a superuser or the database owner, connected to acme_commerce.
CREATE SCHEMA acme AUTHORIZATION acme_app;
GRANT CONNECT ON DATABASE acme_commerce TO acme_app;
GRANT USAGE, CREATE ON SCHEMA acme TO acme_app;

-- Optional hardening: stop acme_app creating anything in public.
REVOKE CREATE ON SCHEMA public FROM acme_app;
```

The application's `CREATE SCHEMA IF NOT EXISTS acme` then succeeds trivially because the schema
already exists.

### 2.5 Verify the role can actually do its job

Discovering a privilege problem now is much cheaper than discovering it from a failed migration.

```bash
PGPASSWORD='REPLACE_WITH_A_LONG_RANDOM_PASSWORD' \
psql -h REPLACE_HOST -p 5432 -U acme_app -d acme_commerce \
  -c 'CREATE SCHEMA IF NOT EXISTS _probe;' \
  -c 'CREATE TABLE _probe.t (id int);' \
  -c 'DROP SCHEMA _probe CASCADE;'
```

Three successful statements and no error means the role has what it needs.

---

## 3. Pointing the application at it

Either a single URL or discrete variables. **Not both** — the config layer rejects that rather
than resolving it by precedence rules nobody remembers.

```bash
# Style A — one connection string. Preferred on Unraid: one field to paste.
DATABASE_URL=postgres://acme_app:REPLACE_PASSWORD@REPLACE_HOST:5432/acme_commerce

# Style B — discrete variables. Preferred in CI, or when overriding one piece.
PGHOST=REPLACE_HOST
PGPORT=5432
PGDATABASE=acme_commerce
PGUSER=acme_app
PGPASSWORD=REPLACE_PASSWORD
```

**Percent-encode special characters in a `DATABASE_URL` password.** `@`, `/`, `:`, `?`, `#`,
and `%` all mean something in a URL. A password of `p@ss/word` must appear as `p%40ss%2Fword`,
or the string parses into a different host and you get an authentication failure that looks
exactly like a wrong password. Style B has no such problem, which is a reason to prefer it when
your password is awkward.

### TLS

| `DB_SSL`    | Behaviour                                     | When                                                                                             |
| ----------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `disable`   | No TLS.                                       | The application and PostgreSQL share a private Docker network. Nothing untrusted is on the wire. |
| `require`   | TLS required, certificate chain **verified**. | Across any network you do not control.                                                           |
| `no-verify` | TLS required, certificate **not** verified.   | Only for a self-signed certificate you cannot yet replace.                                       |

Be clear-eyed about `no-verify`: it encrypts the connection, so it stops passive eavesdropping,
and it does **not** authenticate the server, so it does not stop an active attacker who can
redirect your traffic. It is a stopgap, not a security control.

### Pool sizing

`DB_POOL_MAX` (default 10) is **per application container**. Two replicas at 10 each open 20
server-side connections. PostgreSQL's own `max_connections` (commonly 100) is the ceiling, and
it is shared with every other client on that server — including your `psql` session and
anything else on the Unraid box. Sizing pools past that ceiling produces
`FATAL: sorry, too many clients already`, which reads like an application bug and is not one.

---

## 4. Migrations

Migrations are an **explicit step**. `MIGRATE_ON_STARTUP` defaults to `false` (see
[D-020](DECISIONS.md#d-020)).

```bash
npm run migrate:status      # read-only: what is applied, what is pending
npm run migrate:up          # apply everything pending
npm run migrate:down        # roll back exactly one migration
npm run migrate:create -- add_product_handle
```

In a container, the compiled equivalents:

```bash
docker exec acme-commerce node dist/db/cli.js status
docker exec acme-commerce node dist/db/cli.js up
```

`migrate:status` exits **non-zero (2)** when migrations are pending, so a deployment script can
gate on it without parsing output.

Migration state lives in `acme.kysely_migration`. Kysely takes an advisory lock during
`migrate:up`, so two concurrent runners queue rather than collide.

### What a migration will and will not do

- It will create and alter objects **inside the application schema only**.
- It will **never** drop the schema. That is `db:reset`, which is a different command with a
  different guard.
- A failing migration is rolled back within its own transaction. Migrations applied before it
  stay applied — inspect with `migrate:status` and fix forward.

---

## 5. Seed data

```bash
npm run db:seed
```

Loads 20 products and 49 variants: five vendors, ten product types, twelve tags, all three
statuses, prices from $9.50 to $1,449, and creation dates spread across nineteen months. Enough
that every documented filter, sort field, and search term returns a different, non-trivial
answer.

Two properties worth relying on:

- **Idempotent.** It upserts on the primary key. Running it twice leaves the same state as
  running it once, and a half-finished run can simply be re-run.
- **Non-destructive.** It never deletes. A product you created by hand at a Postman checkpoint
  survives re-seeding. Getting back to a pristine catalog is `db:reset`'s job — a seed command
  that quietly wipes your work is one you learn to fear.

Identifiers are derived from a SHA-256 of each product's handle, so the Trailhead backpack has
the same id on your laptop, in CI, and on Unraid. That is what lets a test or a documentation
example reference a specific record.

Seed data is fictional. No real names, brands, or personal data.

---

## 6. Resetting development data

```bash
npm run db:reset -- --i-know-this-deletes-data
# or: CONFIRM_DESTRUCTIVE=yes npm run db:reset
```

Drops the `acme` schema, recreates it, re-applies every migration, and re-seeds.

It **refuses to run** when:

- `APP_ENV` or `NODE_ENV` is `production` — and the confirmation flag is _not_ an override; or
- destructive intent was not stated explicitly.

There is no interactive prompt, on purpose. A prompt cannot run in CI, and a prompt you can pipe
`yes` into is not a safeguard.

The operation is scoped **by construction**: `DROP SCHEMA "acme" CASCADE` cannot reach an object
outside that schema. Compare with truncating a hand-maintained list of table names, where the
safety of the operation depends on the list being complete — and silently stops being so the
moment someone adds a table.

---

## 7. Test database safety

Integration tests drop and recreate the application schema. Before opening a connection,
`src/db/guard.ts` refuses to proceed if **any** of these hold:

1. `APP_ENV` or `NODE_ENV` is `production`.
2. `TEST_DATABASE_URL` is not set. An unset variable must never resolve to "use the real one".
3. The **resolved target** of the test database equals that of the application database.
   Resolved target means the normalised `(host, port, database)` triple: `localhost`,
   `127.0.0.1`, `::1`, `0.0.0.0`, and `host.docker.internal` all collapse to one value, and an
   omitted port becomes 5432. Comparing raw connection strings would let `localhost` and
   `127.0.0.1` look like two databases when they are one — which is exactly the accident this
   check exists to prevent.
4. The database name does not match `test_*`, `*_test`, or `*_test_*`.

Every failing reason is reported at once, not just the first.

The guard is unit-tested in `tests/unit/guard.test.ts` (34 cases), because an untested safety
mechanism is a comment that happens to compile. It was also verified empirically: pointing
`TEST_DATABASE_URL` at the development database with only a `localhost` / `127.0.0.1`
difference is refused.

**To rename rather than relax.** If the guard blocks you, the fix is to point it at a genuinely
separate database with a `test` name — not to soften the check.

---

## 8. Backup

The application does not back itself up. Two approaches, depending on what you want to survive.

### Logical backup — `pg_dump`

Restorable across PostgreSQL versions, human-inspectable, and scoped to what you ask for.

```bash
# Just the Acme Commerce schema. Small, and cannot disturb anything else on the server.
pg_dump -h REPLACE_HOST -p 5432 -U acme_app \
        -d acme_commerce \
        --schema=acme \
        --format=custom \
        --file=acme_commerce_$(date +%Y%m%d_%H%M%S).dump

# Schema only, no rows — useful for diffing what migrations actually produced.
pg_dump -h REPLACE_HOST -U acme_app -d acme_commerce --schema=acme --schema-only \
        --file=acme_schema.sql
```

`--format=custom` (rather than plain SQL) allows selective restore and parallel restore, and
compresses.

### Physical backup

A filesystem-level copy of PostgreSQL's data directory, or an Unraid share snapshot. Captures
everything including WAL, restores fast, and only restores to the same major version. If your
Unraid PostgreSQL container's data lives on a share you already snapshot, you have this
already — check whether you do before building anything.

**A backup you have not restored is a hypothesis.** Restore into a scratch database at least
once and count the rows.

---

## 9. Restore

```bash
# Into a fresh database (the safe rehearsal).
createdb -h REPLACE_HOST -U REPLACE_ADMIN_USER acme_commerce_restore_check
pg_restore -h REPLACE_HOST -U REPLACE_ADMIN_USER -d acme_commerce_restore_check \
           acme_commerce_20260901_120000.dump

# Verify before trusting it.
psql -h REPLACE_HOST -U REPLACE_ADMIN_USER -d acme_commerce_restore_check \
     -c 'SELECT count(*) FROM acme.products;' \
     -c 'SELECT count(*) FROM acme.variants;' \
     -c 'SELECT name FROM acme.kysely_migration ORDER BY name;'
```

That last query matters: it tells you which migrations the backup was taken at. Restoring a
dump from before a migration and then running application code from after it is a mismatch
`/ready` will report as `not_ready` — which is the check doing its job.

To restore over an existing database, drop only the application's schema first:

```sql
DROP SCHEMA acme CASCADE;
```

Then `pg_restore`. Note that this is exactly the scoping property from §6: the destructive step
cannot reach anything that is not ours.

---

## 10. Troubleshooting

| Symptom                                   | Most likely cause                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ECONNREFUSED`                            | Nothing is listening at that host and port. Check the port is published, and that you are using the right one for your connection model.                     |
| `ENOTFOUND` / `EAI_AGAIN`                 | Hostname does not resolve. On Docker, a container name only resolves on a **shared user-defined network** — never on the default bridge.                     |
| `ETIMEDOUT`                               | Something is dropping packets. A firewall, or the wrong subnet.                                                                                              |
| `password authentication failed`          | Wrong password — or special characters in a `DATABASE_URL` that were not percent-encoded (§3).                                                               |
| `database "acme_commerce" does not exist` | §2.2 not run, or run on a different server than you think.                                                                                                   |
| `permission denied for schema`            | The role does not own the database. §2.4.                                                                                                                    |
| `no pg_hba.conf entry for host`           | The server is not configured to accept connections from that address. This is a PostgreSQL server-side setting, not something the application can influence. |
| `sorry, too many clients already`         | `max_connections` exhausted. Sum `DB_POOL_MAX` across every container plus every other client (§3).                                                          |
| `relation "products" does not exist`      | Migrations have not been applied. `npm run migrate:status`.                                                                                                  |
| `/ready` reports pending migrations       | New code, old schema. Run `migrate:up`.                                                                                                                      |

The fastest single diagnostic is `GET /ready`. Outside production it names the database it
tried, with the password redacted, and reports each check separately — which distinguishes
"wrong host" from "wrong password" from "schema not migrated" without guessing.
