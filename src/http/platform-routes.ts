/**
 * Platform endpoints: liveness, readiness, and the machine-readable contract.
 *
 * These are deliberately OUTSIDE the `/api/v1` prefix and outside the `data`/`error` envelope.
 *
 * They are not part of the product API. They are consumed by a Docker HEALTHCHECK, by Unraid,
 * and by a human trying to work out why a container will not serve traffic — not by an
 * application developer writing an integration. Forcing them into the API's envelope would
 * make them worse at that job, and versioning them would mean a container probe has to track
 * API versions.
 *
 * This is the kind of inconsistency a governance review should notice and then accept, as
 * distinct from the unintentional kind. It is called out here so the reasoning is on record.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { pingDatabase } from '../db/index.js';
import { getMigrationStatus } from '../db/migrator.js';
import { redactConnectionString } from '../config/index.js';

const TAG = 'Platform';

const CheckSchema = Type.Object(
  {
    status: Type.Unsafe<'ok' | 'fail'>({
      type: 'string',
      enum: ['ok', 'fail'],
      description: 'Whether this individual check passed.',
    }),
    detail: Type.String({
      description: 'Human-readable explanation, useful when the check failed.',
    }),
    duration_ms: Type.Number({ description: 'How long this check took, in milliseconds.' }),
  },
  { additionalProperties: false },
);

export const HealthResponseSchema = Type.Object(
  {
    status: Type.Unsafe<'ok'>({
      type: 'string',
      enum: ['ok'],
      description:
        'Always "ok". If the process could not answer, you would get no response at all.',
    }),
    service: Type.String({
      description: 'Service name, for when several services share a log stream.',
    }),
    version: Type.String({
      description: 'Deployed application version. Use it to confirm an image update took effect.',
    }),
    environment: Type.String({
      description: 'Configured APP_ENV: development, test, or production.',
    }),
    uptime_seconds: Type.Number({
      description:
        'Seconds since this process started. A resetting value means it is crash-looping.',
    }),
  },
  {
    $id: 'HealthResponse',
    examples: [
      {
        status: 'ok',
        service: 'acme-commerce',
        version: '0.3.0',
        environment: 'production',
        uptime_seconds: 84021.7,
      },
    ],
    title: 'HealthResponse',
    description: 'Liveness. Answered from process state alone; no dependency is contacted.',
    additionalProperties: false,
  },
);

export const ReadinessResponseSchema = Type.Object(
  {
    status: Type.Unsafe<'ready' | 'not_ready'>({
      type: 'string',
      enum: ['ready', 'not_ready'],
      description: 'Overall verdict. `not_ready` is returned with HTTP 503.',
    }),
    checks: Type.Object(
      {
        configuration: CheckSchema,
        database: CheckSchema,
        migrations: CheckSchema,
      },
      {
        additionalProperties: false,
        description: 'Per-dependency results, so a failure names itself.',
      },
    ),
    checked_at: Type.String({
      format: 'date-time',
      description: 'When these checks ran. Results are not cached.',
    }),
  },
  {
    $id: 'ReadinessResponse',
    examples: [
      {
        status: 'ready',
        checks: {
          configuration: { status: 'ok', detail: 'Configuration loaded.', duration_ms: 0.1 },
          database: { status: 'ok', detail: 'SELECT 1 succeeded.', duration_ms: 3.4 },
          migrations: { status: 'ok', detail: 'All 3 migrations applied.', duration_ms: 2.1 },
        },
        checked_at: '2025-01-14T15:20:00.000Z',
      },
    ],
    title: 'ReadinessResponse',
    description:
      'Readiness. Returns 200 when the application can serve API traffic and 503 when it ' +
      'cannot. The body shape is identical for both, so a client parses one thing.',
    additionalProperties: false,
  },
);

export const PLATFORM_SHARED_SCHEMAS = [HealthResponseSchema, ReadinessResponseSchema];

/** A check that cannot hang the probe. A readiness endpoint that blocks is worse than useless. */
async function timed(
  label: string,
  timeoutMs: number,
  fn: () => Promise<string>,
): Promise<{ status: 'ok' | 'fail'; detail: string; duration_ms: number }> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const detail = await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} check timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return {
      status: 'ok',
      detail,
      duration_ms: Math.round((performance.now() - started) * 100) / 100,
    };
  } catch (err) {
    return {
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      duration_ms: Math.round((performance.now() - started) * 100) / 100,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const READINESS_CHECK_TIMEOUT_MS = 3000;

export async function registerPlatformRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        operationId: 'getHealth',
        summary: 'Liveness probe',
        description: [
          'Reports that the process is running and able to answer HTTP. **It does not contact',
          'PostgreSQL**, and it does not fail when the database is down.',
          '',
          'That is the whole distinction between liveness and readiness, and getting it wrong',
          'is a classic outage amplifier: if a liveness probe fails during a database blip, the',
          'orchestrator restarts every application container, and now you have a database',
          'outage plus a thundering herd of cold starts. Liveness answers "should this process',
          'be killed and replaced?" — a database outage is not a reason to kill this process.',
          '',
          'Use this for a Docker HEALTHCHECK. Use `/ready` to decide whether to send traffic.',
        ].join('\n'),
        tags: [TAG],
        response: {
          200: { $ref: 'HealthResponse#', description: 'The process is alive.' },
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      service: 'acme-commerce',
      version: app.appConfig.version,
      environment: app.appConfig.appEnv,
      uptime_seconds: Math.round(process.uptime() * 100) / 100,
    }),
  );

  app.get(
    '/ready',
    {
      schema: {
        operationId: 'getReadiness',
        summary: 'Readiness probe',
        description: [
          'Reports whether the application can serve API traffic right now. Three checks:',
          '',
          '1. **configuration** — required settings were present and valid at startup. This one',
          '   cannot realistically fail here, because invalid configuration prevents the process',
          '   from starting at all. It is reported so the probe output is a complete picture.',
          '2. **database** — a live round trip to PostgreSQL. Catches a wrong host, a wrong',
          '   password, a firewall, and a stopped database container.',
          '3. **migrations** — whether every migration on disk has been applied. A container',
          '   running new code against an old schema is a specific, common, and confusing',
          '   failure; it is worth its own check.',
          '',
          'Returns `200` when all three pass and `503` when any fails, with the same body shape',
          'either way. Each check reports its own duration, so "the database is slow" and "the',
          'database is unreachable" look different.',
          '',
          'Outside production the body also names the database being checked, with the password',
          'removed — that is usually the fastest way to discover a container is pointed at the',
          'wrong host.',
        ].join('\n'),
        tags: [TAG],
        response: {
          200: {
            $ref: 'ReadinessResponse#',
            description: 'Every check passed; the application can serve traffic.',
          },
          503: {
            $ref: 'ReadinessResponse#',
            description: 'At least one check failed. Inspect `checks` to see which.',
          },
        },
      },
    },
    async (_request, reply) => {
      const configuration = await timed('configuration', READINESS_CHECK_TIMEOUT_MS, async () => {
        const target = app.appConfig.isProduction
          ? 'configured'
          : `configured; database target ${redactConnectionString(app.appConfig.database.connectionString)}, schema "${app.appConfig.database.schema}"`;
        return target;
      });

      const database = await timed('database', READINESS_CHECK_TIMEOUT_MS, async () => {
        await pingDatabase(app.db);
        return 'connection established and query round-tripped';
      });

      const migrations =
        database.status === 'ok'
          ? await timed('migrations', READINESS_CHECK_TIMEOUT_MS, async () => {
              const status = await getMigrationStatus(app.db, app.appConfig.database.schema);
              if (status.total === 0) throw new Error('no migration files were found');
              if (!status.isUpToDate) {
                throw new Error(
                  `${status.pending.length} migration(s) pending: ${status.pending.join(', ')}. ` +
                    `Run the migration command before serving traffic.`,
                );
              }
              return `${status.applied.length} of ${status.total} applied; schema is current`;
            })
          : {
              status: 'fail' as const,
              detail: 'skipped because the database check failed',
              duration_ms: 0,
            };

      const allOk =
        configuration.status === 'ok' && database.status === 'ok' && migrations.status === 'ok';

      reply.code(allOk ? 200 : 503);
      return {
        status: allOk ? ('ready' as const) : ('not_ready' as const),
        checks: { configuration, database, migrations },
        checked_at: new Date().toISOString(),
      };
    },
  );

  app.get(
    '/openapi.json',
    {
      schema: {
        operationId: 'getOpenApiDocument',
        summary: 'Machine-readable API contract',
        description: [
          'Returns the OpenAPI 3.1 document describing this API.',
          '',
          'It is generated from the same JSON Schema objects that validate incoming requests and',
          'serialize outgoing responses, so it cannot describe a request shape the server would',
          'reject or a response field the server would strip.',
          '',
          'What that guarantee does NOT cover: whether a `description` is accurate, whether an',
          '`example` is current, or whether an operation is missing entirely. Those need review',
          'and linting, not generation.',
          '',
          'Import this URL into Postman to generate a collection skeleton.',
        ].join('\n'),
        tags: [TAG],
        response: {
          200: {
            description: 'The OpenAPI 3.1 document.',
            content: {
              'application/json': {
                schema: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      reply.type('application/json; charset=utf-8');
      return app.swagger();
    },
  );
}
