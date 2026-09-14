import { Type, type Static } from '@sinclair/typebox';
import { PERMISSIONS, ROLES } from './permissions.js';

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
    title: 'TokenResponse',
    additionalProperties: false,
    description: 'A newly issued development bearer token, with the identity it represents.',
  },
);

export const IdentityResponseSchema = Type.Object(
  { data: Type.Unsafe<Static<typeof IdentitySchema>>({ $ref: 'Identity#' }) },
  {
    $id: 'IdentityResponse',
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
