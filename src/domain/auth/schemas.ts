import { Type, type Static } from '@sinclair/typebox';
import { PERMISSIONS, ROLES } from './permissions.js';

/**
 * A worked example of the authenticated caller, shared by every schema that embeds one.
 *
 * The `developer` role deliberately, since that is the seeded account the collection
 * authenticates as. The token is truncated — a realistic-looking but non-functional JWT, so
 * nobody copies it out of the documentation and wonders why it is rejected.
 */
export const IDENTITY_EXAMPLE = {
  id: 'usr_4c1f8e2a7b9d0c3e5f6a8b1d',
  email: 'dev@acme.example',
  name: 'Devon Reyes',
  role: 'developer',
  permissions: [
    'catalog:read',
    'catalog:write',
    'locations:read',
    'locations:write',
    'inventory:read',
    'inventory:write',
    'pricing:read',
  ],
  token_expires_at: '2025-01-14T16:20:00.000Z',
};

const RoleSchema = Type.Unsafe<(typeof ROLES)[number]>({
  type: 'string',
  enum: [...ROLES],
  description:
    'Internal role. Determines the permission set; permissions are derived from the role at ' +
    'request time, never carried inside the token.',
});

const PermissionSchema = Type.Unsafe<(typeof PERMISSIONS)[number]>({
  type: 'string',
  enum: [...PERMISSIONS],
  description: 'A single capability, in `domain:action` form.',
});

export const TokenRequestSchema = Type.Object(
  {
    email: Type.String({
      minLength: 3,
      maxLength: 320,
      description: 'Email address of a development user. Case-insensitive.',
    }),
    password: Type.String({
      minLength: 1,
      maxLength: 200,
      description: "The user's password. Seeded development users share one; see the README.",
    }),
  },
  {
    $id: 'TokenRequest',
    title: 'TokenRequest',
    additionalProperties: false,
    description: 'Credentials exchanged for a bearer token.',
    examples: [{ email: 'dev@acme.example', password: 'dev-password-123' }],
  },
);
export type TokenRequestInput = Static<typeof TokenRequestSchema>;

export const IdentitySchema = Type.Object(
  {
    id: Type.String({ description: 'User identifier. Appears as the `sub` claim in the token.' }),
    email: Type.String({ description: 'Email address.' }),
    name: Type.String({ description: 'Display name.' }),
    role: RoleSchema,
    permissions: Type.Array(PermissionSchema, {
      description: 'Every permission this role holds. What a 403 is checked against.',
    }),
    token_expires_at: Type.String({
      format: 'date-time',
      description: 'When the presented token stops being accepted.',
    }),
  },
  {
    $id: 'Identity',
    examples: [IDENTITY_EXAMPLE],
    title: 'Identity',
    additionalProperties: false,
    description: 'The authenticated caller, as the server currently understands them.',
  },
);

export const TokenResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        access_token: Type.String({
          description:
            'A JWT. Send it as `Authorization: Bearer <token>`. It is signed, not encrypted — ' +
            'anyone holding it can read every claim inside it, so treat it as a credential.',
        }),
        token_type: Type.Unsafe<'Bearer'>({
          type: 'string',
          enum: ['Bearer'],
          description: 'Always `Bearer`.',
        }),
        expires_in: Type.Integer({ description: 'Lifetime in seconds from issue.' }),
        expires_at: Type.String({ format: 'date-time', description: 'Absolute expiry, RFC 3339.' }),
        principal: Type.Unsafe<Static<typeof IdentitySchema>>({ $ref: 'Identity#' }),
      },
      { additionalProperties: false },
    ),
  },
  {
    $id: 'TokenResponse',
    examples: [
      {
        data: {
          access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.<payload>.<signature>',
          token_type: 'Bearer',
          expires_in: 3600,
          expires_at: '2025-01-14T16:20:00.000Z',
          principal: IDENTITY_EXAMPLE,
        },
      },
    ],
    title: 'TokenResponse',
    additionalProperties: false,
    description: 'A newly issued development bearer token, with the identity it represents.',
  },
);

export const IdentityResponseSchema = Type.Object(
  { data: Type.Unsafe<Static<typeof IdentitySchema>>({ $ref: 'Identity#' }) },
  {
    $id: 'IdentityResponse',
    examples: [{ data: IDENTITY_EXAMPLE }],
    title: 'IdentityResponse',
    additionalProperties: false,
    description: 'The identity behind the presented token.',
  },
);

export const AUTH_SHARED_SCHEMAS = [
  TokenRequestSchema,
  IdentitySchema,
  TokenResponseSchema,
  IdentityResponseSchema,
];
