/**
 * Request validation.
 *
 * Fastify validates with Ajv out of the box. This module replaces the single default Ajv
 * instance with two, because request bodies and query strings need genuinely different
 * treatment:
 *
 *   - **Query strings and path parameters** arrive as strings. `?limit=25` must become the
 *     number 25 before an `Integer` schema can accept it, so type coercion is ON.
 *
 *   - **Request bodies** arrive as parsed JSON that already has real types. Coercion here
 *     would turn `{"price_cents": "1999"}` into a valid request, quietly accepting a client
 *     bug that a strict API should reject. So coercion is OFF.
 *
 * That distinction is invisible with one shared Ajv instance, and it is the reason this file
 * exists rather than a two-line `ajv: { customOptions: ... }` in the Fastify constructor.
 */
// Ajv 8 ships CommonJS. Under NodeNext ESM the named `Ajv` export resolves correctly for
// both the class value and its type, which the default import does not.
import { Ajv, type ErrorObject, type Options as AjvOptions } from 'ajv';
// ajv-formats is CommonJS: `module.exports = exports = formatsPlugin`. Node's ESM interop
// therefore makes the default import the plugin function itself (verified at runtime), but
// TypeScript models a CJS default import as the whole `module.exports` namespace under
// NodeNext. Hence one explicit cast, with the reason written down rather than left as a
// mysterious `as any`.
import ajvFormatsDefault from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';

const addFormats = ajvFormatsDefault as unknown as FormatsPlugin;

import type { FastifyInstance } from 'fastify';
import type { FieldProblem } from './errors.js';

const SHARED_OPTIONS: AjvOptions = {
  // Report every problem in one response. With allErrors off, Ajv stops at the first failure,
  // so a body with four mistakes takes four round trips to fix.
  allErrors: true,
  // Never strip unknown properties. Fastify's default is `removeAdditional: true`, which
  // silently deletes them — combined with `additionalProperties: false` in our schemas that
  // would mean a typo'd field is removed and the request succeeds. We want the 400.
  removeAdditional: false,
  // Apply `default` values from the schema, so `page` and `limit` are populated without every
  // handler repeating `?? 1`.
  useDefaults: true,
  // Ajv's strict mode complains about legitimate OpenAPI 3.1 constructs such as `examples`
  // on a schema object. Turning it off avoids fighting the tool over vocabulary.
  strict: false,
};

function buildAjv(extra: AjvOptions): Ajv {
  const ajv = new Ajv({ ...SHARED_OPTIONS, ...extra });
  // Teaches Ajv `date-time`, `email`, `uri`, etc. Unused for request validation in Milestone 1
  // and installed now so the first schema that needs it does not fail silently: without this,
  // an unknown `format` is IGNORED rather than enforced.
  addFormats(ajv);
  return ajv;
}

export interface ValidationSetup {
  /**
   * Register a shared schema with Fastify (for `$ref` resolution and OpenAPI components) and
   * with both Ajv instances (so `$ref` actually resolves at validation time).
   */
  addSchema(schema: Record<string, unknown>): void;
}

export function setupValidation(app: FastifyInstance): ValidationSetup {
  const bodyAjv = buildAjv({ coerceTypes: false });
  const paramAjv = buildAjv({ coerceTypes: true });

  app.setValidatorCompiler(({ schema, httpPart }) => {
    const ajv = httpPart === 'body' ? bodyAjv : paramAjv;
    return ajv.compile(schema);
  });

  return {
    addSchema(schema) {
      app.addSchema(schema);
      bodyAjv.addSchema(schema);
      paramAjv.addSchema(schema);
    },
  };
}

/** Where a validation failure occurred, in words a caller will recognise. */
const PART_LABEL: Record<string, string> = {
  body: 'body',
  querystring: 'query',
  params: 'path',
  headers: 'header',
};

/** `/tags/0/name` -> `tags[0].name` */
function instancePathToField(instancePath: string): string {
  if (!instancePath) return '';
  return instancePath
    .split('/')
    .filter(Boolean)
    .map((segment) => (/^\d+$/.test(segment) ? `[${segment}]` : `.${segment}`))
    .join('')
    .replace(/^\./, '');
}

function quote(name: string): string {
  return `"${name}"`;
}

/**
 * Translate Ajv's output into the API's `error.details.fields` array.
 *
 * Ajv messages are written for a schema author ("must have required property 'title'",
 * "must be >= 0"). They omit the field name, use JSON-Pointer paths, and read as fragments.
 * A consumer debugging a failed POST needs the field name, the rule, and — for closed sets —
 * the list of values that would have worked.
 */
export function translateAjvErrors(part: string, errors: readonly ErrorObject[]): FieldProblem[] {
  const label = PART_LABEL[part] ?? part;
  const problems: FieldProblem[] = [];

  for (const err of errors) {
    const base = instancePathToField(err.instancePath);
    const path = (leaf?: string) =>
      [label, base, leaf].filter((s) => s !== undefined && s !== '').join(base && leaf ? '.' : '.');

    switch (err.keyword) {
      case 'required': {
        const name = String((err.params as { missingProperty: string }).missingProperty);
        problems.push({
          field: path(name),
          rule: 'required',
          message: `${quote(name)} is required.`,
        });
        break;
      }
      case 'additionalProperties': {
        const name = String((err.params as { additionalProperty: string }).additionalProperty);
        problems.push({
          field: path(name),
          rule: 'unknown_property',
          message:
            `${quote(name)} is not a recognised ${label} property. Unknown properties are ` +
            `rejected rather than ignored, so that a typo is visible instead of silent.`,
        });
        break;
      }
      case 'enum': {
        const allowed = (err.params as { allowedValues?: readonly unknown[] }).allowedValues ?? [];
        problems.push({
          field: path(),
          rule: 'enum',
          message: `${quote(base || label)} must be one of: ${allowed.join(', ')}.`,
          allowed,
        });
        break;
      }
      case 'type': {
        const expected = String((err.params as { type: string | string[] }).type);
        problems.push({
          field: path(),
          rule: 'type',
          message: `${quote(base || label)} must be of type ${expected}.`,
        });
        break;
      }
      case 'minimum':
      case 'exclusiveMinimum':
      case 'maximum':
      case 'exclusiveMaximum': {
        const { comparison, limit } = err.params as { comparison: string; limit: number };
        problems.push({
          field: path(),
          rule: err.keyword,
          message: `${quote(base || label)} must be ${comparison} ${limit}.`,
        });
        break;
      }
      case 'minLength':
      case 'maxLength': {
        const { limit } = err.params as { limit: number };
        problems.push({
          field: path(),
          rule: err.keyword,
          message:
            err.keyword === 'minLength'
              ? `${quote(base || label)} must be at least ${limit} character(s).`
              : `${quote(base || label)} must be at most ${limit} character(s).`,
        });
        break;
      }
      case 'minItems':
      case 'maxItems': {
        const { limit } = err.params as { limit: number };
        problems.push({
          field: path(),
          rule: err.keyword,
          message:
            err.keyword === 'minItems'
              ? `${quote(base || label)} must contain at least ${limit} item(s).`
              : `${quote(base || label)} must contain at most ${limit} item(s).`,
        });
        break;
      }
      case 'pattern': {
        const { pattern } = err.params as { pattern: string };
        problems.push({
          field: path(),
          rule: 'pattern',
          message: `${quote(base || label)} must match the pattern ${pattern}.`,
        });
        break;
      }
      case 'minProperties': {
        problems.push({
          field: label,
          rule: 'min_properties',
          message:
            `The ${label} must contain at least one property. An empty PATCH body is almost ` +
            `always a client bug, so it is rejected rather than treated as a no-op.`,
        });
        break;
      }
      default: {
        problems.push({
          field: path(),
          rule: err.keyword,
          message: `${quote(base || label)} ${err.message ?? 'is invalid'}.`,
        });
      }
    }
  }

  // Ajv can report the same field twice (for example `type` and `enum` from a union). One
  // entry per field-and-rule keeps the error readable.
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = `${p.field}|${p.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
