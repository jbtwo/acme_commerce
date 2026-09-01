/**
 * Builds the real application for HTTP integration tests.
 *
 * The instance under test is produced by the same `buildApp()` the container runs — same
 * hooks, same validation, same error handler, same serializers. Only the transport differs:
 * `fastify.inject()` drives a request through the full stack without opening a socket.
 *
 * What that buys: speed and no port conflicts. What it does not prove: anything about the
 * network, TLS, proxies, or the container's own listener. `scripts/smoke.sh` covers those,
 * over a real socket, which is why both exist.
 */
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { resetTestDatabase, type TestDatabase } from './database.js';

export interface TestHarness {
  app: FastifyInstance;
  db: TestDatabase['db'];
  close: () => Promise<void>;
}

export async function createTestHarness(options: { seed?: boolean } = {}): Promise<TestHarness> {
  const testDb = await resetTestDatabase(options);
  // The harness owns the pool and passes it in, so closing the app does not also close a
  // connection the test still wants for direct database assertions.
  const app = await buildApp({ config: testDb.config, db: testDb.db });
  await app.ready();
  return {
    app,
    db: testDb.db,
    close: async () => {
      await app.close();
      await testDb.close();
    },
  };
}

/** Parse an inject response body, failing loudly rather than returning undefined. */
export function json<T = unknown>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Response body was not JSON: ${body.slice(0, 400)}`);
  }
}

export interface ApiError {
  error: { code: string; message: string; request_id: string; details?: Record<string, unknown> };
}
