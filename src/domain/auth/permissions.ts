/**
 * Roles and permissions.
 *
 * A **role** is the coarse label attached to a user. A **permission** is what route handlers
 * actually check. Keeping them separate means adding a fourth role later is one entry in this
 * table rather than an edit to every route — and it means a route's requirement reads as
 * "needs `inventory:write`" rather than "needs developer or admin", which stays true when the
 * set of roles changes.
 */

export const ROLES = ['developer', 'support', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'catalog:read',
  'catalog:write',
  'locations:read',
  'locations:write',
  'inventory:read',
  'inventory:write',
  'pricing:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * The authorization matrix. This table IS the policy — there is no other place where a role's
 * capabilities are decided, so reading this is sufficient to know what anyone can do.
 *
 * `support` is deliberately read-only across every domain. That is not a contrivance to make
 * a 403 reachable; it is what a support role should be. It also happens to make the
 * authorization tests meaningful, because there is a real identity that must be refused.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  developer: [
    'catalog:read',
    'catalog:write',
    'locations:read',
    'locations:write',
    'inventory:read',
    'inventory:write',
    'pricing:read',
  ],
  support: ['catalog:read', 'locations:read', 'inventory:read', 'pricing:read'],
  admin: [...PERMISSIONS],
};

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** The authenticated caller, attached to the request once a token has been verified. */
export interface Principal {
  /** User id — the token's `sub` claim. */
  id: string;
  email: string;
  name: string;
  role: Role;
  permissions: readonly Permission[];
  /** Token expiry, as a Unix timestamp in seconds. */
  expiresAt: number;
}
