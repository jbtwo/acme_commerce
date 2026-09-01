// ESLint 10 flat config.
// Kept deliberately small: rules that catch real defects, not rules that enforce taste.
// Formatting is Prettier's job; eslint-config-prettier turns off anything that overlaps.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'openapi/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // eslint.config.js is not covered by tsconfig.json (which includes only .ts
          // files), so the TypeScript project service cannot type it. Listing it here lets it
          // be linted with a default project rather than excluded from linting entirely.
          // vitest.config.ts is already covered by tsconfig.json and must NOT be listed.
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          // Enforces the layering rule from docs/ARCHITECTURE.md: HTTP status codes are the
          // route layer's business. A service that knows about 404 has leaked transport concerns.
          selector: "MemberExpression[object.name='reply'][property.name='raw']",
          message: 'Use the Fastify reply API rather than the raw Node response.',
        },
      ],
    },
  },
  {
    // The CLI and scripts are operator-facing tools; printing to stdout is their purpose.
    files: ['src/db/cli.ts', 'src/db/seed/**/*.ts', 'src/openapi/generate.ts'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
