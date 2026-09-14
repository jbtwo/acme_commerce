/**
 * Authentication business logic.
 */
import { AuthenticationError } from '../../http/errors.js';
import type { AppDatabase } from '../../db/index.js';
import type { UserRow } from '../../db/schema.js';
import { verifyPassword } from './passwords.js';
import { permissionsForRole, type Principal, type Role } from './permissions.js';
import * as repo from './repository.js';
import { signToken, verifyToken, TokenVerificationError } from './tokens.js';

export interface AuthSettings {
  tokenSecret: string;
  tokenTtlSeconds: number;
}

export interface IssuedToken {
  accessToken: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
  expiresAt: string;
  principal: Principal;
}

function toPrincipal(user: UserRow, expiresAtUnix: number): Principal {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    permissions: permissionsForRole(user.role as Role),
    expiresAt: expiresAtUnix,
  };
}

/**
 * Exchange an email and password for a bearer token.
 *
 * Every failure path returns the identical `INVALID_CREDENTIALS` error: unknown email, wrong
 * password, and deactivated account are indistinguishable to the caller. Differentiating them
 * would turn this endpoint into an account-enumeration oracle — "this email exists but the
 * password is wrong" is exactly what an attacker wants to learn.
 *
 * A dummy verification runs when the email is unknown so that the response time does not
 * reveal whether the account exists either. Without it, "no such user" returns in
 * microseconds while a real user costs a full scrypt, and the difference is measurable.
 */
export async function issueToken(
  db: AppDatabase,
  credentials: { email: string; password: string },
  settings: AuthSettings,
): Promise<IssuedToken> {
  const user = await repo.findUserByEmail(db, credentials.email);

  if (!user || !user.is_active) {
    await burnEquivalentTime(credentials.password);
    throw new AuthenticationError('INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  if (!(await verifyPassword(credentials.password, user.password_hash))) {
    throw new AuthenticationError('INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  const { token, expiresAt } = await signToken(
    { sub: user.id, email: user.email, name: user.name, role: user.role as Role },
    { secret: settings.tokenSecret, ttlSeconds: settings.tokenTtlSeconds },
  );

  return {
    accessToken: token,
    tokenType: 'Bearer',
    expiresInSeconds: settings.tokenTtlSeconds,
    expiresAt: expiresAt.toISOString(),
    principal: toPrincipal(user, Math.floor(expiresAt.getTime() / 1000)),
  };
}

/** A real scrypt against a throwaway hash, so an unknown email costs the same as a known one. */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
async function burnEquivalentTime(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_HASH);
}

/**
 * Verify a bearer token and resolve the caller.
 *
 * The user is re-read from the database on every request rather than trusted from the token.
 * That costs a query and buys the only revocation this design has: deactivating a user takes
 * effect immediately instead of waiting out the token's expiry. Role changes apply
 * immediately for the same reason — permissions are derived from the current row, never from
 * the `role` claim baked in at sign time.
 */
export async function resolvePrincipal(
  db: AppDatabase,
  token: string,
  settings: AuthSettings,
): Promise<Principal> {
  let claims;
  try {
    claims = await verifyToken(token, { secret: settings.tokenSecret });
  } catch (err) {
    if (err instanceof TokenVerificationError) {
      throw err.reason === 'expired'
        ? new AuthenticationError('TOKEN_EXPIRED', 'Your token has expired. Request a new one.', {
            hint: 'POST /api/v1/auth/token',
          })
        : new AuthenticationError('INVALID_TOKEN', 'The bearer token is not valid.');
    }
    throw err;
  }

  const user = await repo.findUserById(db, claims.sub);
  if (!user || !user.is_active) {
    throw new AuthenticationError(
      'INVALID_TOKEN',
      'The token refers to an account that is no longer active.',
    );
  }
  return toPrincipal(user, claims.exp);
}
