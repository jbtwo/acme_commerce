import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Integration tests share one PostgreSQL test database and reset the schema between
    // files. Running files in parallel would let one file's reset truncate another file's
    // fixtures mid-assertion. The suite is small; determinism is worth more than the seconds.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: './test-results/junit.xml' },
  },
});
