/**
 * Logging configuration.
 *
 * Structured JSON by default. A log line is a queryable event, not a sentence: when you are
 * looking for "every 500 on POST /api/v1/products in the last hour", `grep` over prose loses
 * and a field filter wins.
 *
 * Pretty-printing is available for a human at a terminal (LOG_PRETTY=true) and is off in
 * containers and CI, where something else is reading the output.
 */
import type { FastifyServerOptions } from 'fastify';
import type { Config } from '../config/index.js';

/**
 * Header and body fields that must never reach the log.
 *
 * `authorization` and `x-api-key` are unused in Milestone 1 and listed now on purpose:
 * redaction that is added after the credential exists is redaction that was added after
 * the credential was already logged.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.secret',
  '*.token',
];

export function buildLoggerOptions(config: Config): FastifyServerOptions['logger'] {
  return {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // Every line carries these, so a log aggregator can separate environments and versions
    // without the operator remembering to filter.
    base: { service: 'acme-commerce', env: config.appEnv, version: config.version },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    // Fastify's default request/response serializers log a large amount per line. These keep
    // the fields that answer "what happened and to whom" and drop the rest.
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: request.url,
          route: request.routeOptions?.url,
          remote_address: request.ip,
        };
      },
      res(reply) {
        return { status_code: reply.statusCode };
      },
    },
    ...(config.logPretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname,service,env,version',
              messageFormat: '{request_id} {msg}',
            },
          },
        }
      : {}),
  };
}
