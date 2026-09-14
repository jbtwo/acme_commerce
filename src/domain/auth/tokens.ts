/**
 * Development bearer tokens (JWT, HS256).
 *
 * ## What a JWT actually is
 *
 * Three base64url-encoded segments joined by dots:
 *
 *     eyJhbGciOiJIUzI1NiJ9 . eyJzdWIiOiJ1c3JfLi4uIiwicm9sZSI6ImRldmVsb3BlciJ9 . 4f3a...
 *     └──── header ──────┘   └──────────────── payload (claims) ────────────┘   └ signature
 *
 * Paste one into any decoder — or run `atob(token.split('.')[1])` in Postman's console — and
 * every claim is legible.
 *
 * **That is the property people most often get wrong: a JWT is signed, not encrypted.**
 * Anyone holding it can read every claim in it. The signature makes the claims *tamper-evident*
 * — change `role` to `admin` and verification fails, because the signature no longer matches —
 * but it hides nothing. Never put anything in a token that the bearer should not see.
 *
 * ## Why a library
 *
 * Signing HS256 by hand is about sixty lines of `node:crypto` and would make the mechanics
 * visible in our own source, which is tempting for a learning project. It is also how you end
 * up with a verifier that accepts `{"alg":"none"}`, or compares signatures with `===` and leaks
 * the answer through timing. `jose` has already had those bugs found in it. The anatomy is
 * explained here; the verification is delegated.
 *
 * ## Why stateless, and what it costs
 *
 * No token is stored anywhere. Verification is a signature check, so it needs no database
 * round trip — which is the main reason JWTs are popular.
 *
 * The cost is that **a token cannot be revoked**. There is no list to remove it from. Once
 * issued it is valid until `exp`, and the only lever is rotating `AUTH_TOKEN_SECRET`, which
 * invalidates every token at once. That is why the default TTL is an hour: the expiry window
 * is the blast radius of a leaked token. A production system that needs logout keeps a
 * server-side session or a revocation list, and gives up the statelessness to get it.
 */
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { Permission, Role } from './permissions.js';

const ALGORITHM = 'HS256';
const ISSUER = 'acme-commerce';
const AUDIENCE = 'acme-commerce-internal';

/** Claims we put in the token. Nothing here is secret — see the note above. */
export interface TokenClaims {
  /** Subject: the user id. */
  sub: string;
  email: string;
  name: string;
  role: Role;
}

export interface VerifiedToken extends TokenClaims {
  /** Expiry, Unix seconds. */
  exp: number;
  /** Issued at, Unix seconds. */
  iat: number;
}

/** Why verification failed. The route layer maps these to distinct error codes. */
export type TokenFailure = 'expired' | 'invalid';

export class TokenVerificationError extends Error {
  readonly reason: TokenFailure;
  constructor(reason: TokenFailure, message: string) {
    super(message);
    this.name = 'TokenVerificationError';
    this.reason = reason;
  }
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signToken(
  claims: TokenClaims,
  options: { secret: string; ttlSeconds: number; now?: Date },
): Promise<{ token: string; expiresAt: Date; issuedAt: Date }> {
  const issuedAt = options.now ?? new Date();
  const iat = Math.floor(issuedAt.getTime() / 1000);
  const exp = iat + options.ttlSeconds;

  const token = await new SignJWT({ email: claims.email, name: claims.name, role: claims.role })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secretKey(options.secret));

  return { token, expiresAt: new Date(exp * 1000), issuedAt: new Date(iat * 1000) };
}

/**
 * Verify a token and return its claims, or throw `TokenVerificationError`.
 *
 * `algorithms: [ALGORITHM]` is the line that matters most. Without pinning the accepted
 * algorithm, a verifier will honour whatever the *token's own header* asks for — so an
 * attacker sets `alg` to `none` and supplies no signature, or switches an RS256 setup to HS256
 * and signs with the public key. Both are real, named, repeatedly-exploited attacks. The
 * algorithm is our decision, never the token's.
 */
export async function verifyToken(
  token: string,
  options: { secret: string; now?: Date },
): Promise<VerifiedToken> {
  try {
    const { payload } = await jwtVerify(token, secretKey(options.secret), {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
      ...(options.now ? { currentDate: options.now } : {}),
    });

    const { sub, email, name, role, exp, iat } = payload as Record<string, unknown>;
    if (
      typeof sub !== 'string' ||
      typeof email !== 'string' ||
      typeof name !== 'string' ||
      typeof role !== 'string' ||
      typeof exp !== 'number' ||
      typeof iat !== 'number'
    ) {
      throw new TokenVerificationError('invalid', 'Token is missing required claims.');
    }
    return { sub, email, name, role: role as Role, exp, iat };
  } catch (err) {
    if (err instanceof TokenVerificationError) throw err;
    // Expiry is separated from every other failure because it is the one case where the
    // correct client behaviour is "get a new token and retry" — and a client cannot infer
    // that from a generic "invalid token".
    if (err instanceof joseErrors.JWTExpired) {
      throw new TokenVerificationError('expired', 'The bearer token has expired.');
    }
    throw new TokenVerificationError('invalid', 'The bearer token is not valid.');
  }
}

/**
 * Pull the token out of an `Authorization` header.
 *
 * Returns null for anything that is not exactly `Bearer <token>`. The scheme comparison is
 * case-insensitive because RFC 7235 says the scheme is; the token itself is not touched.
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/** Permissions are derived from the role at verification time, never carried in the token. */
export type { Permission, Role };
