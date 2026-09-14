/**
 * A fixed-window rate limiter, in memory.
 *
 * Applied to `POST /api/v1/auth/token`, which is unauthenticated and runs scrypt on every
 * call. scrypt is deliberately expensive — that is the whole point of a password KDF — so an
 * open endpoint that runs one per request is a cheap CPU-exhaustion target as well as a
 * credential-guessing one. This project is deployed on a NAS on a home network; the limit is
 * not theoretical hardening.
 *
 * ## Fixed window, and what that means
 *
 * Requests are counted per key per window. At 10/minute a caller can make 10 requests at
 * 11:59:59 and 10 more at 12:00:00 — 20 in one second, straddling the boundary. A sliding
 * window fixes that and costs more state. For slowing password guessing from millions per
 * second to twenty, the boundary effect does not matter, and the simplicity does.
 *
 * ## What this is not
 *
 * In-memory, so it resets on restart and does not coordinate across replicas. Two containers
 * behind a load balancer allow twice the configured rate. For one container that is fine; the
 * fix is a shared store, and that belongs with the second replica rather than before it.
 *
 * Keyed on client IP, which is spoofable behind a misconfigured proxy and shared by everyone
 * behind one NAT. It raises the cost of guessing; it does not make guessing impossible.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Requests remaining in the current window. */
  remaining: number;
  /** Seconds until the window resets — the value for `Retry-After`. */
  retryAfterSeconds: number;
  limit: number;
}

interface Window {
  count: number;
  /** Epoch milliseconds at which this window expires. */
  resetAt: number;
}

export class FixedWindowRateLimiter {
  readonly #windows = new Map<string, Window>();
  readonly #max: number;
  readonly #windowMs: number;
  /** Bounds memory: a flood of distinct keys must not grow the map without limit. */
  readonly #maxKeys: number;

  constructor(options: { max: number; windowSeconds: number; maxKeys?: number }) {
    this.#max = options.max;
    this.#windowMs = options.windowSeconds * 1000;
    this.#maxKeys = options.maxKeys ?? 10_000;
  }

  check(key: string, now: number = Date.now()): RateLimitResult {
    this.#evictExpired(now);

    const existing = this.#windows.get(key);
    if (!existing || existing.resetAt <= now) {
      // A distinct-key flood would otherwise be its own memory-exhaustion vector, so once the
      // map is full new keys are allowed through rather than tracked. Failing open is the
      // right call here: this limiter protects CPU, and refusing every new client to protect
      // a hash map would be a worse outage than the one it prevents.
      if (this.#windows.size >= this.#maxKeys) {
        return { allowed: true, remaining: this.#max - 1, retryAfterSeconds: 0, limit: this.#max };
      }
      this.#windows.set(key, { count: 1, resetAt: now + this.#windowMs });
      return { allowed: true, remaining: this.#max - 1, retryAfterSeconds: 0, limit: this.#max };
    }

    existing.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    if (existing.count > this.#max) {
      return { allowed: false, remaining: 0, retryAfterSeconds, limit: this.#max };
    }
    return {
      allowed: true,
      remaining: this.#max - existing.count,
      retryAfterSeconds: 0,
      limit: this.#max,
    };
  }

  /** Test seam, and used when a login succeeds so a legitimate user is not punished. */
  reset(key?: string): void {
    if (key === undefined) this.#windows.clear();
    else this.#windows.delete(key);
  }

  get size(): number {
    return this.#windows.size;
  }

  #evictExpired(now: number): void {
    // Only worth walking the map when it has grown; at a handful of keys this is noise.
    if (this.#windows.size < 64) return;
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(key);
    }
  }
}
