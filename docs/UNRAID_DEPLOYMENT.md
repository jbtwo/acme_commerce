# Unraid deployment

How to run the Acme Commerce container on Unraid against the PostgreSQL container you already
have.

**Not covered, on purpose:** creating a PostgreSQL container, managing the PostgreSQL server,
or Docker Compose. None of those are part of this project.

Every value in `REPLACE_*` form is a placeholder. This document cannot know your container
names, network names, IP addresses, ports, or credentials, and guessing them would produce
instructions that look authoritative and are wrong.

> **Verification status:** everything here was exercised locally against PostgreSQL 17.11 in a
> container, including both connection models below. Nothing was run on an actual Unraid server.
> `docs/BUILD_VERIFICATION.md` lists precisely what was and was not verified.

---

## 1. Prepare the database

Follow [`POSTGRES_SETUP.md`](POSTGRES_SETUP.md) §2 against your existing PostgreSQL container.
The short version — open a shell into your PostgreSQL container from the Unraid UI (**Docker**
tab → the container's icon → **Console**) or over SSH:

```bash
# Inside the PostgreSQL container:
psql -U postgres
```

```sql
CREATE ROLE acme_app WITH LOGIN PASSWORD 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';
CREATE DATABASE acme_commerce OWNER acme_app ENCODING 'UTF8';
```

Then verify the role can create a schema, which is the only privilege that matters here:

```bash
PGPASSWORD='REPLACE_WITH_A_LONG_RANDOM_PASSWORD' \
  psql -U acme_app -d acme_commerce -h 127.0.0.1 \
  -c 'CREATE SCHEMA IF NOT EXISTS _probe; DROP SCHEMA _probe;'
```

If that succeeds, the database side is done. Note your PostgreSQL container's **exact name** —
you will need it for Model A.

---

## 2. Choose a connection model

This is the decision that everything else follows from. Both work; they differ in what is
exposed and in what hostname the application uses.

```mermaid
flowchart TB
    subgraph A["Model A — shared user-defined network"]
        A1[acme-commerce] -->|"host: postgres-container-name<br/>port: 5432"| A2[(PostgreSQL)]
        A3[LAN] -.->|"cannot reach PostgreSQL"| A2
        A3 -->|"port 3000 published"| A1
    end
    subgraph B["Model B — via the Unraid host's published port"]
        B1[acme-commerce] -->|"host: UNRAID_LAN_IP<br/>port: published Postgres port"| B2[(PostgreSQL)]
        B3[LAN] -->|"can also reach PostgreSQL"| B2
        B3 -->|"port 3000 published"| B1
    end
```

### Model A — a shared user-defined Docker network (recommended)

Both containers join a Docker network you create. The application addresses PostgreSQL by its
**container name**, resolved by Docker's embedded DNS.

```bash
# On the Unraid host, once:
docker network create acme-net

# Attach both containers. This does not restart them.
docker network connect acme-net REPLACE_POSTGRES_CONTAINER_NAME
docker network connect acme-net acme-commerce
```

Then the connection string uses the container name and PostgreSQL's **internal** port —
5432 — regardless of what port it publishes to the LAN:

```
DATABASE_URL=postgres://acme_app:REPLACE_PASSWORD@REPLACE_POSTGRES_CONTAINER_NAME:5432/acme_commerce
```

**Why prefer this.** PostgreSQL does not need to publish a port to the LAN at all. If it
currently does, you can stop publishing it, and the database becomes unreachable from anything
except containers you explicitly attach to `acme-net`. That is a real reduction in exposure, and
it is free.

**The one thing that trips people up.** Container-name DNS works **only** on a user-defined
network. On Unraid's default `bridge`, container names do not resolve — you get `ENOTFOUND`,
which looks like a typo and is not. If `ENOTFOUND` is your error, the first thing to check is
whether both containers are genuinely on `acme-net`:

```bash
docker network inspect acme-net --format '{{range .Containers}}{{.Name}} {{end}}'
```

### Model B — through the Unraid host's published PostgreSQL port

The application connects to the Unraid host's LAN IP on whatever port PostgreSQL publishes.

```
DATABASE_URL=postgres://acme_app:REPLACE_PASSWORD@REPLACE_UNRAID_LAN_IP:REPLACE_PUBLISHED_PG_PORT/acme_commerce
```

Note this uses the **published** port (often 5432, possibly something else), not the internal
one.

**When to choose it.** Your PostgreSQL already publishes a port and other things on your LAN
use it; or you want to point your laptop's development environment at the same server; or the
network plumbing in Model A is more change than you want today.

**What it costs.** PostgreSQL is reachable by anything on your LAN. That is a much larger
surface than Model A, and it is why `DB_SSL=require` is worth considering here even on a home
network.

**Do not use `host.docker.internal` on Unraid.** It is a Docker Desktop convenience and does
not exist on Linux Docker unless you add `--add-host=host.docker.internal:host-gateway`
explicitly. Use the LAN IP.

### Comparison

|                                  | Model A (shared network)                   | Model B (host port)         |
| -------------------------------- | ------------------------------------------ | --------------------------- |
| Database hostname                | PostgreSQL's container name                | Unraid's LAN IP             |
| Database port                    | `5432` (internal)                          | The **published** port      |
| Must PostgreSQL publish a port?  | **No**                                     | Yes                         |
| Reachable from your LAN?         | No                                         | Yes                         |
| Survives a container IP change?  | Yes — DNS by name                          | Yes — the host IP is stable |
| Breaks if a container is renamed | Yes                                        | No                          |
| Extra setup                      | One `docker network create`, two `connect` | None                        |
| Recommended                      | **Yes**                                    | Acceptable                  |

---

## 3. Get the image onto Unraid

### 3.1 Option A — Docker Hub automated build (recommended)

Point Docker Hub at your GitHub repository and let it build. The `Dockerfile` is at the
repository root, which is where Docker Hub's default build context expects it, so there is
nothing to configure beyond linking the two.

On Docker Hub: **Repository → Builds → Link to GitHub**, choose `jbtwo/acme_commerce`, and add a
build rule. A reasonable starting pair:

| Source type | Source      | Docker tag | Dockerfile location |
| ----------- | ----------- | ---------- | ------------------- |
| Branch      | `main`      | `edge`     | `/Dockerfile`       |
| Tag         | `/^v(.*)$/` | `{\1}`     | `/Dockerfile`       |

The second rule means `git tag v0.1.0 && git push --tags` publishes `:0.1.0`. That keeps the
image tag, the git tag, and the `version` reported by `GET /health` all agreeing, which is what
makes "which build is running?" answerable.

Three things this buys you over building locally:

- **Architecture is handled.** Docker Hub builds on `linux/amd64`, which is what your Unraid box
  almost certainly needs. See §3.2 for why that matters if you ever build locally instead.
- **It builds from a clean checkout**, so a build that depends on something only present on your
  laptop fails on Docker Hub rather than silently working for you and nobody else.
- **It is reproducible.** `npm ci` installs exactly what `package-lock.json` specifies.

**Verified:** a clean `git clone` of this repository, with no `.env` and no `node_modules`, built
for `linux/amd64` with `--no-cache`, produces an image that starts, connects to PostgreSQL, and
returns `200` from both `/health` and `/ready`.

Then on Unraid, set **Repository** to `REPLACE_DOCKERHUB_USER/acme-commerce:0.1.0`.

**Public or private?** The image contains **no credentials** — verified: no `.env` file, no
`.dev-postgres.env`, and the only baked-in environment variables are the seven non-secret
defaults (`APP_ENV`, `HOST`, `PORT`, `LOG_LEVEL`, `LOG_PRETTY`, `NODE_ENV`,
`MIGRATE_ON_STARTUP`). All configuration arrives at runtime. A public repository therefore leaks
nothing your public GitHub repository does not already.

The thing to keep private is not the image, it is **the deployment**: there is no authentication
in Milestone 1, so anyone who can reach port 3000 can delete your catalog. See §13.

Re-check that claim whenever the `Dockerfile` changes, rather than trusting this paragraph:

```bash
docker run --rm --entrypoint sh REPLACE_DOCKERHUB_USER/acme-commerce:0.1.0 -c \
  'find / -name ".env*" -not -path "*/node_modules/*" 2>/dev/null; ls -a /app; env'
```

### 3.2 If you build locally instead: check the architecture first

Only relevant when _you_ run `docker build` rather than Docker Hub. Docker builds for the
architecture of the machine doing the building, and an Apple Silicon Mac produces `linux/arm64`.

On the Unraid terminal:

```bash
uname -m
```

- `x86_64` → you need **`linux/amd64`**. This is almost every Unraid box.
- `aarch64` → you need **`linux/arm64`**.

Pull an `arm64` image on an `x86_64` host and you get:

```
exec /usr/local/bin/node: exec format error
```

The container appears to start, dies immediately, and the single log line does not point at the
cause. It is the most common way a first hand-built deployment fails from a Mac.

Check what you have, and build for what you need:

```bash
docker image inspect acme-commerce:0.1.0 --format '{{.Os}}/{{.Architecture}}'

docker buildx build --platform linux/amd64 -t acme-commerce:0.1.0 --load .
```

To publish one tag that serves the right binary to whatever pulls it, list both platforms.
Multi-platform builds **must** use `--push`; the local daemon cannot hold a multi-arch manifest,
so `--load` fails:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t REPLACE_DOCKERHUB_USER/acme-commerce:0.1.0 --push .

docker buildx imagetools inspect REPLACE_DOCKERHUB_USER/acme-commerce:0.1.0
```

That last command prints every platform in the manifest. If `linux/amd64` is absent, Unraid will
not run it.

Cross-architecture builds run under emulation. For this project that costs seconds rather than
minutes, because no dependency needs native compilation — which is part of why the stack was
chosen that way.

### 3.3 Option B — GitHub Container Registry

The same commands with a different host. Worth preferring if you would rather keep image
distribution next to the source, and it is what CI will use in Milestone 5:

```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u REPLACE_GITHUB_USER --password-stdin
docker buildx build --platform linux/amd64 \
  -t ghcr.io/REPLACE_GITHUB_USER/acme-commerce:0.1.0 --push .
```

### 3.4 Option C — build on the Unraid host

No registry, and no architecture problem at all, because the build happens on the machine that
will run it.

```bash
cd /mnt/user/appdata/acme_commerce   # wherever you cloned it
docker build -t acme-commerce:0.1.0 .
```

The tradeoff: your Unraid box does the build, needs the source and a network connection to npm,
and accumulates build-cache layers on the array.

### 3.5 Option D — transfer a tarball

No registry needed. Still architecture-sensitive, so build with `--platform` first.

```bash
docker buildx build --platform linux/amd64 -t acme-commerce:0.1.0 --load .
docker save acme-commerce:0.1.0 | gzip > acme-commerce-0.1.0.tar.gz
scp acme-commerce-0.1.0.tar.gz root@REPLACE_UNRAID_HOST:/tmp/
ssh root@REPLACE_UNRAID_HOST 'gunzip -c /tmp/acme-commerce-0.1.0.tar.gz | docker load'
```

### 3.6 Tag with a real version, never `latest`

`latest` makes "which build is running?" unanswerable and turns rollback into guesswork.
`GET /health` reports `version` from `package.json`, which is only useful if the tag means
something. Bump `package.json`, tag to match, and the two agree.

## 4. Environment variables

| Variable                  | Required                   | Unraid value                                                                   | Notes                                                                 |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `DATABASE_URL`            | **Yes** (or the `PG*` set) | `postgres://acme_app:REPLACE_PASSWORD@REPLACE_HOST:REPLACE_PORT/acme_commerce` | Percent-encode special characters in the password                     |
| `APP_ENV`                 | Recommended                | `production`                                                                   | Disables destructive tooling; hides the database target from `/ready` |
| `NODE_ENV`                | Recommended                | `production`                                                                   | Keep aligned with `APP_ENV`                                           |
| `HOST`                    | No                         | `0.0.0.0`                                                                      | **Already the image default.** Do not set `127.0.0.1`                 |
| `PORT`                    | No                         | `3000`                                                                         | The port _inside_ the container                                       |
| `LOG_LEVEL`               | No                         | `info`                                                                         | `debug` while diagnosing                                              |
| `LOG_PRETTY`              | No                         | `false`                                                                        | Already the image default                                             |
| `DB_SSL`                  | No                         | `disable` (Model A) / consider `require` (Model B)                             | See POSTGRES_SETUP §3                                                 |
| `DB_POOL_MAX`             | No                         | `10`                                                                           | Per container. Sum across containers against `max_connections`        |
| `DB_STATEMENT_TIMEOUT_MS` | No                         | `15000`                                                                        | Server-side cap on a single query                                     |
| `DB_SCHEMA`               | No                         | `acme`                                                                         | Change only if you have a reason                                      |
| `MIGRATE_ON_STARTUP`      | No                         | `false`                                                                        | Already the image default. See §6                                     |
| `TEST_DATABASE_URL`       | **No**                     | _unset_                                                                        | Belongs on a development machine, never here                          |

Do **not** set `TEST_DATABASE_URL` in a production deployment. It has no effect on the running
application, and its presence is an invitation for someone to run destructive tooling that the
guard would then have one fewer reason to refuse.

### `HOST` is the mistake to avoid

The image defaults `HOST` to `0.0.0.0`. If you override it to `127.0.0.1`, the container will
start cleanly, report itself healthy from the inside, and refuse every connection from outside.
Published ports reach the container's network interface; loopback is not it. This is the single
most common "it starts but nothing works" cause in containerised applications.

---

## 5. Mapping to the Unraid Docker UI

Unraid's **Docker** tab → **Add Container**. The form's fields map like this:

| Unraid field              | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| **Name**                  | `acme-commerce`                                                             |
| **Repository**            | `acme-commerce:0.1.0`, or `ghcr.io/REPLACE_GITHUB_USER/acme-commerce:0.1.0` |
| **Network Type**          | **Custom: acme-net** for Model A. **Bridge** for Model B.                   |
| **Console shell command** | `sh` (alpine has no bash)                                                   |
| **Privileged**            | Off. It is not needed and the process runs as a non-root user anyway.       |

Then **Add another Path, Port, Variable, Label or Device** for each of:

| Type         | Name / Key     | Container value        | Host value                        |
| ------------ | -------------- | ---------------------- | --------------------------------- |
| **Port**     | HTTP           | `3000`                 | `3000`, or another free host port |
| **Variable** | `DATABASE_URL` | see §4                 | —                                 |
| **Variable** | `APP_ENV`      | `production`           | —                                 |
| **Variable** | `DB_SSL`       | `disable` or `require` | —                                 |

**No Path mappings are needed.** The application writes nothing to disk: all state is in
PostgreSQL and all configuration is in environment variables. That is what makes an image
update safe (§7).

For a secret like `DATABASE_URL`, set the variable's display type to **Password** in the
template editor so it is masked in the UI. Unraid stores the template on disk in plain text
either way — this hides it from a shoulder, not from the filesystem.

### The equivalent `docker run`

If you prefer the command line, or want to know what the UI is building:

```bash
# Model A
docker run -d \
  --name acme-commerce \
  --network acme-net \
  -p 3000:3000 \
  -e DATABASE_URL='postgres://acme_app:REPLACE_PASSWORD@REPLACE_POSTGRES_CONTAINER_NAME:5432/acme_commerce' \
  -e APP_ENV=production \
  -e DB_SSL=disable \
  --restart unless-stopped \
  acme-commerce:0.1.0

# Model B
docker run -d \
  --name acme-commerce \
  -p 3000:3000 \
  -e DATABASE_URL='postgres://acme_app:REPLACE_PASSWORD@REPLACE_UNRAID_LAN_IP:REPLACE_PUBLISHED_PG_PORT/acme_commerce' \
  -e APP_ENV=production \
  -e DB_SSL=require \
  --restart unless-stopped \
  acme-commerce:0.1.0
```

`--init` is optional. The application installs its own `SIGTERM` and `SIGINT` handlers, so
signals are handled correctly without it; `--init` adds a PID-1 zombie reaper this process does
not need.

---

## 6. Apply migrations

**The container starts without migrating.** It will report `/ready` as `not_ready` with
`migrations: fail` until you do this. That is the design (see [D-020](DECISIONS.md#d-020)):
automatic migration on boot is how two replicas start the same migration in the same second, and
it removes the moment at which you could decide _not_ to.

```bash
# See what is pending. Read-only, changes nothing.
docker exec acme-commerce node dist/db/cli.js status

# Apply it.
docker exec acme-commerce node dist/db/cli.js up

# Confirm.
docker exec acme-commerce node dist/db/cli.js status
```

Expected output when current:

```
  [applied] 0001_catalog

1 applied, 0 pending, 1 total.
Database is up to date.
```

From the Unraid UI: **Docker** tab → the container's icon → **Console**, then run the same
commands without the `docker exec acme-commerce` prefix.

`status` exits non-zero (2) when migrations are pending, so a deployment script can gate on it.

---

## 7. Load seed data (optional)

Seed data is realistic sample catalog data. Useful on a learning deployment, and probably not
what you want if you intend to enter real products.

```bash
docker exec acme-commerce node dist/db/cli.js seed
```

Idempotent and non-destructive: it upserts 20 products and 49 variants and never deletes, so
anything you created by hand survives.

`db:reset` is **refused** when `APP_ENV=production`, and the confirmation flag is not an
override. Verified — see BUILD_VERIFICATION.

---

## 8. Verify the deployment

In this order. Each step rules out a different cause.

```bash
# 1. Is the process alive? Does not touch PostgreSQL.
curl -s http://REPLACE_UNRAID_HOST:3000/health
# {"status":"ok","service":"acme-commerce","version":"0.1.0","environment":"production","uptime_seconds":12.4}
```

`version` is worth reading — it is how you confirm an image update actually took effect rather
than assuming it did.

```bash
# 2. Can it serve traffic? Checks config, PostgreSQL, and migration currency.
curl -s -o /dev/null -w '%{http_code}\n' http://REPLACE_UNRAID_HOST:3000/ready
# 200

curl -s http://REPLACE_UNRAID_HOST:3000/ready
```

A `503` names which check failed:

```json
{
  "status": "not_ready",
  "checks": {
    "configuration": { "status": "ok", "detail": "configured", "duration_ms": 0.07 },
    "database": {
      "status": "fail",
      "detail": "Connection terminated due to connection timeout",
      "duration_ms": 1502
    },
    "migrations": {
      "status": "fail",
      "detail": "skipped because the database check failed",
      "duration_ms": 0
    }
  },
  "checked_at": "2026-09-01T16:55:02.114Z"
}
```

That is the fastest diagnostic this deployment has. It distinguishes wrong host from wrong
password from unmigrated schema without guessing.

```bash
# 3. Does the API return data?
curl -s 'http://REPLACE_UNRAID_HOST:3000/api/v1/products?limit=2'

# 4. Is the contract published?
curl -s http://REPLACE_UNRAID_HOST:3000/openapi.json | head -c 200

# 5. Docker's own healthcheck (liveness only).
docker inspect -f '{{.State.Health.Status}}' acme-commerce
# healthy
```

Then open `http://REPLACE_UNRAID_HOST:3000/docs` in a browser for Swagger UI.

---

## 9. Update the image without losing data

The application writes **nothing** to disk. All state is in PostgreSQL, which this container
does not own. That is what makes updating boring:

```bash
# 1. Get the new image.
docker pull ghcr.io/REPLACE_GITHUB_USER/acme-commerce:0.2.0
#   or: docker build -t acme-commerce:0.2.0 .

# 2. Stop the old container gracefully. SIGTERM drains in-flight requests.
docker stop acme-commerce

# 3. Remove it. This destroys no data.
docker rm acme-commerce

# 4. Start the new one with the SAME environment variables.
docker run -d --name acme-commerce --network acme-net -p 3000:3000 \
  -e DATABASE_URL='...' -e APP_ENV=production \
  --restart unless-stopped \
  acme-commerce:0.2.0

# 5. Apply any new migrations.
docker exec acme-commerce node dist/db/cli.js up

# 6. Verify the new version is actually running.
curl -s http://REPLACE_UNRAID_HOST:3000/health
curl -s -o /dev/null -w '%{http_code}\n' http://REPLACE_UNRAID_HOST:3000/ready
```

From the Unraid UI, "Force Update" on the container does steps 1–4. You still have to do steps
5 and 6.

**Order matters when a release contains a migration.** Safest sequence: back up (§10), apply the
migration, _then_ deploy the new image — which requires the migration to be **backward
compatible** with the code currently running. If it is not (a dropped or renamed column), you
need a two-release expand-then-contract sequence. That is the subject of the Milestone 5
breaking-change exercise, and it is a genuinely hard problem rather than a checklist item.

**Rollback** is `docker stop && docker rm && docker run` with the previous tag. Schema changes
do not roll back with it — `migrate:down` rolls back exactly one migration and only if the
migration wrote a working `down`.

---

## 10. Back up and restore

Details in [`POSTGRES_SETUP.md`](POSTGRES_SETUP.md) §8–9. On Unraid specifically:

```bash
# Dump just the Acme Commerce schema, from inside the PostgreSQL container.
docker exec REPLACE_POSTGRES_CONTAINER_NAME \
  pg_dump -U acme_app -d acme_commerce --schema=acme --format=custom \
  > /mnt/user/backups/acme_commerce_$(date +%Y%m%d).dump
```

Two things worth doing rather than intending to do:

1. **Check whether your PostgreSQL container's data directory is already on a share you
   snapshot.** If it is, you have physical backups already, and building a `pg_dump` cron job on
   top may be redundant. Find out before building it.
2. **Restore one into a scratch database and count the rows.** A backup you have not restored is
   a hypothesis. `POSTGRES_SETUP.md` §9 has the commands, including the query that tells you
   which migration the dump was taken at.

---

## 11. Troubleshooting startup

Read the logs first. They are structured JSON, one object per line:

```bash
docker logs --tail 50 acme-commerce
```

| Symptom                                                           | Cause                                                           | Fix                                                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Exits immediately, `Invalid configuration (N problems)`           | Missing or invalid environment variables. Exit code **78**.     | The message lists **every** problem. Fix them all and restart once.                                       |
| Exits with `No database configuration found`                      | Neither `DATABASE_URL` nor the `PG*` set is present.            | Set `DATABASE_URL`. Check for a stray leading space in the Unraid variable field.                         |
| `Set either DATABASE_URL or the discrete PG* variables, not both` | Both styles configured.                                         | Remove one. Rejected rather than resolved by precedence, on purpose.                                      |
| Starts, `/health` 200, `/ready` 503 with `database: fail`         | Cannot reach PostgreSQL.                                        | §12 below.                                                                                                |
| Starts, `/ready` 503 with `migrations: fail ... pending`          | Migrations not applied.                                         | §6.                                                                                                       |
| Container runs but nothing on the LAN can connect                 | `HOST` overridden to `127.0.0.1`, or the port is not published. | Unset `HOST` (the image default is correct) and check the port mapping.                                   |
| Port already allocated                                            | Something else holds the host port.                             | Map to a different host port; the container port stays 3000.                                              |
| `docker stop` takes ~10 s then kills                              | Not expected — the application drains in ~200 ms.               | Check the logs for `shutdown signal received; draining`. If absent, the process is not receiving SIGTERM. |

---

## 12. Troubleshooting database connectivity

Work outward from the container.

```bash
# 1. What does the application think it is connecting to?
#    Outside production, /ready reports the target with the password redacted.
docker exec acme-commerce sh -c 'echo "$DATABASE_URL"' | sed 's/:[^:@]*@/:****@/'

# 2. Can the container resolve the database host? (Model A)
docker exec acme-commerce node -e "require('node:dns').promises.lookup('REPLACE_POSTGRES_CONTAINER_NAME').then(console.log).catch(e=>console.error(e.code))"
#    ENOTFOUND -> the two containers are not on a shared user-defined network.

# 3. Are both containers actually on the network?
docker network inspect acme-net --format '{{range .Containers}}{{.Name}} {{end}}'

# 4. Can the container open a TCP connection to the port?
docker exec acme-commerce node -e "
const s=require('node:net').connect(5432,'REPLACE_POSTGRES_CONTAINER_NAME');
s.on('connect',()=>{console.log('TCP OK');s.end()});
s.on('error',e=>console.error('TCP FAIL',e.code));
s.setTimeout(4000,()=>{console.error('TCP TIMEOUT');s.destroy()});"

# 5. Do the credentials work? Ask PostgreSQL directly, from its own container.
docker exec REPLACE_POSTGRES_CONTAINER_NAME \
  env PGPASSWORD='REPLACE_PASSWORD' psql -U acme_app -d acme_commerce -h 127.0.0.1 -c 'select 1;'
```

What each result tells you:

- **`ENOTFOUND`** — a DNS problem, not a credentials problem. Model A without a shared
  user-defined network is by far the most common cause.
- **`ECONNREFUSED`** — DNS worked, nothing is listening on that port. Wrong port, or you used
  the published port in Model A where the internal one is required.
- **`ETIMEDOUT`** — packets are being dropped. Firewall or wrong subnet.
- **TCP OK but `password authentication failed`** — the network is fine. Wrong password, or
  special characters in the URL that were not percent-encoded.
- **TCP OK, auth OK, but `relation "products" does not exist`** — everything is fine except that
  migrations have not run. §6.

---

## 13. Security notes for this deployment

This is a learning environment. Be deliberate about where you put it.

- **There is no authentication in Milestone 1.** Every Catalog endpoint, including
  `POST`, `PATCH`, and `DELETE`, is open to anyone who can reach the port. Bearer tokens arrive
  in Milestone 2.
- **Do not expose port 3000 to the internet.** Not through a router port-forward, not through a
  reverse proxy, not through a tunnel. Keep it on your LAN.
- **Prefer Model A** so PostgreSQL does not need to be reachable from the LAN at all.
- **Use `APP_ENV=production`** on Unraid even though this is not a production system. It disables
  destructive database tooling and stops `/ready` from reporting the database target.
- **Keep the application role unprivileged.** No superuser, no `CREATEDB`, no `CREATEROLE`. If
  that credential leaks, the damage is bounded by what the role can reach.
- **`/docs` and `/openapi.json` are open.** They describe the whole API. On a LAN that is a
  feature; anywhere else it is reconnaissance.
