/**
 * The application version, resolved once at module load.
 *
 * Surfaced by `GET /health` and stamped into `info.version` of the OpenAPI document. Its
 * practical job is answering "did my container update actually take effect?" after a deploy —
 * a question that is otherwise surprisingly hard to answer from the outside.
 *
 * Read from package.json rather than hard-coded, so there is one place to bump. `APP_VERSION`
 * overrides it, which is how a CI build can stamp a commit SHA.
 */
import { createRequire } from 'node:module';

function readPackageVersion(): string {
  try {
    // Works under tsx (src/../package.json) and under node (dist/../package.json), because
    // the Dockerfile places package.json alongside dist/.
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    // A missing package.json must not stop the process from booting. Reporting an unknown
    // version is a much smaller problem than refusing to start.
    return '0.0.0';
  }
}

export const APP_VERSION = process.env.APP_VERSION?.trim() || readPackageVersion();
