/**
 * Outbound pacing: a continuously-refilled token bucket and an inflight semaphore.
 *
 * Lighter enforces per-IP limits on a WebSocket connection (`docs/spec/06-websocket.md` §10.3,
 * `[DOC]` — published documentation, not yet confirmed by capture, since the live capture is
 * geo-blocked):
 *
 * | Limit | Value |
 * | --- | --- |
 * | Client messages per minute | 200, excluding `sendTx` / `sendTxBatch` |
 * | Inflight messages | 50, excluding tx submissions |
 * | Subscriptions per connection | 500 |
 * | Concurrent connections per IP | 255 |
 *
 * Violations surface as API codes 23000–23004 and 30009/30010. Because those numbers are `[DOC]`
 * rather than measured, nothing here treats them as exact: the defaults sit under the documented
 * ceilings (40 inflight against a documented 50), and {@link TokenBucket.throttle} /
 * {@link InflightSemaphore.resize} let the transport back off further when the server disagrees
 * with our arithmetic. Being wrong in the safe direction costs latency; being wrong the other way
 * costs the connection.
 *
 * Both classes are pure decision engines. They hold counters and timestamps, and nothing else — no
 * socket, no queue, no scheduled callback. The transport asks "may this frame go out now?" and, if
 * not, "how long until it may?", then does its own waiting.
 *
 * **There are no timers in this module, by design.** Refill is computed from elapsed time on every
 * call, and a throttle is stored as "the rate is reduced until timestamp T" and evaluated lazily.
 * Two reasons: a Cloudflare Durable Object cannot hibernate while a repeating callback is live, and
 * a stepped refill (`+200 tokens every 60 s`) starves the resubscribe burst that follows every
 * reconnect — a client re-establishing hundreds of subscriptions would drain the bucket and then
 * stall for a full minute mid-resubscribe instead of draining smoothly at the refill rate.
 *
 * Side-effect free at import: no clock is read, and no randomness is drawn, until a method is
 * called.
 */

import { LighterConfigError, LighterValidationError } from "../errors.js";

/**
 * Default clock for {@link TokenBucket}, read lazily and only when no `now` was injected.
 *
 * `performance.now()` is monotonic, exists in every supported runtime (browsers, Bun, Node 20+,
 * Deno, Workers), and cannot run backwards when the wall clock is stepped by NTP — which a rate
 * limiter that subtracts timestamps genuinely cares about. The epoch fallback exists only for an
 * exotic host that omits `performance`; either way the value is used solely in differences, so the
 * two are interchangeable within one bucket's lifetime.
 */
function defaultNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return new Date().getTime();
}

/** Construction parameters for {@link TokenBucket}. */
export interface TokenBucketOptions {
  /** Burst size, and the number of tokens restored over one full `refillIntervalMs`. */
  readonly capacity: number;
  /** Window the capacity refills over. Rate is `capacity / refillIntervalMs` tokens per ms. */
  readonly refillIntervalMs: number;
  /** Injectable clock, in ms. Defaults to a monotonic reading; only differences are used. */
  readonly now?: () => number;
}

function requirePositiveFinite(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new LighterConfigError(`${name} must be a finite number > 0`, { code: "RATELIMIT_OPTION" });
  }
  return value;
}

/**
 * Continuously-refilled token bucket, evaluated lazily against an injected clock.
 *
 * Every non-transaction outbound frame — `subscribe`, `unsubscribe`, keepalive `pong` — draws one
 * token. Transaction frames use a separate lane (they are governed by the REST limits) and must not
 * pass through here.
 *
 * The bucket is fractional on purpose. Integer tokens would round a partially-elapsed refill down
 * to nothing, so a caller polling every few ms would see the bucket never move.
 *
 * State: `tokens`, the timestamp they were last computed at, and an optional throttle window. Owned
 * for the lifetime of the connection that constructed it.
 */
export class TokenBucket {
  #capacity: number;
  #refillIntervalMs: number;
  readonly #now: () => number;

  #tokens: number;
  #lastMs: number;

  /** Multiplier applied to the refill rate inside the throttle window. `1` when not throttled. */
  #throttleFactor = 1;
  #throttleStartMs = 0;
  #throttleUntilMs = 0;

  constructor(opts: TokenBucketOptions) {
    if (opts === null || typeof opts !== "object") {
      throw new LighterConfigError("TokenBucket requires { capacity, refillIntervalMs }", {
        code: "RATELIMIT_OPTION",
      });
    }
    this.#capacity = requirePositiveFinite("capacity", opts.capacity);
    this.#refillIntervalMs = requirePositiveFinite("refillIntervalMs", opts.refillIntervalMs);

    const now = opts.now ?? defaultNow;
    if (typeof now !== "function") {
      throw new LighterConfigError("now must be a function returning a timestamp in ms", {
        code: "RATELIMIT_OPTION",
      });
    }
    this.#now = now;

    // Starts full: a fresh connection is allowed its full burst of subscribe frames.
    this.#tokens = this.#capacity;
    this.#lastMs = now();
  }

  /** Burst size in tokens. */
  get capacity(): number {
    return this.#capacity;
  }

  /** Refill window in ms. The rate is `capacity / refillIntervalMs` tokens per ms. */
  get refillIntervalMs(): number {
    return this.#refillIntervalMs;
  }

  /**
   * Tokens available right now, fractional.
   *
   * Reading this advances the bucket's internal clock — that is what "lazily refilled" means — but
   * it is otherwise observationally pure: reading twice at the same timestamp gives the same value.
   */
  get available(): number {
    this.#refill(this.#now());
    return this.#tokens;
  }

  /** Tokens per millisecond, before any throttle. */
  get #baseRate(): number {
    return this.#capacity / this.#refillIntervalMs;
  }

  /**
   * Take `n` tokens if they are available.
   *
   * Returns `false` without consuming anything when they are not, including the permanent case
   * `n > capacity` — the bucket can never hold that many.
   */
  tryTake(n: number = 1): boolean {
    const want = requireAmount(n);
    this.#refill(this.#now());
    if (this.#tokens < want) return false;
    this.#tokens -= want;
    return true;
  }

  /**
   * `0` when {@link tryTake} would succeed right now; otherwise the wait in ms before it would.
   *
   * Returns `Number.POSITIVE_INFINITY` when `n > capacity`, which is unsatisfiable at any future
   * time. Callers must treat that as "never" rather than feeding it to a scheduler.
   *
   * The wait accounts for an active throttle window, including the moment it expires: if the
   * deficit cannot accrue at the reduced rate before the window ends, the remainder is charged at
   * the full rate.
   */
  msUntilAvailable(n: number = 1): number {
    const want = requireAmount(n);
    if (want > this.#capacity) return Number.POSITIVE_INFINITY;

    const nowMs = this.#now();
    this.#refill(nowMs);
    const deficit = want - this.#tokens;
    if (deficit <= 0) return 0;

    const base = this.#baseRate;
    const throttleRemainingMs = Math.max(0, this.#throttleUntilMs - nowMs);
    if (throttleRemainingMs > 0) {
      const throttledRate = base * this.#throttleFactor;
      const accruedWhileThrottled = throttledRate * throttleRemainingMs;
      if (accruedWhileThrottled >= deficit) return deficit / throttledRate;
      return throttleRemainingMs + (deficit - accruedWhileThrottled) / base;
    }
    return deficit / base;
  }

  /**
   * Rate-limit response: multiply the refill rate by `factor` for the next `forMs`, then restore.
   *
   * Time-based, so no callback is scheduled and nothing has to run to undo it. Calling it again
   * replaces the window rather than nesting: tokens accrued so far are banked at the old rate
   * first, so a throttle is never applied retroactively.
   *
   * `factor` is in `[0, 1]` — this is a brake, not an accelerator. `0` stops refill entirely for
   * the window.
   */
  throttle(factor: number, forMs: number): void {
    if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0 || factor > 1) {
      throw new LighterValidationError(
        "INVALID_THROTTLE_FACTOR",
        "throttle factor must be a number in [0, 1]",
        { field: "factor" },
      );
    }
    if (typeof forMs !== "number" || !Number.isFinite(forMs) || forMs < 0) {
      throw new LighterValidationError(
        "INVALID_THROTTLE_DURATION",
        "throttle duration must be a finite number >= 0 ms",
        { field: "forMs" },
      );
    }
    const nowMs = this.#now();
    this.#refill(nowMs);
    this.#throttleFactor = factor;
    this.#throttleStartMs = nowMs;
    this.#throttleUntilMs = nowMs + forMs;
  }

  /**
   * Replace the rate. Banked tokens are kept, clamped to the new capacity, so lowering the limit
   * takes effect immediately without also handing out a fresh burst.
   */
  setRefillRate(capacity: number, refillIntervalMs: number): void {
    const nextCapacity = requirePositiveFinite("capacity", capacity);
    const nextInterval = requirePositiveFinite("refillIntervalMs", refillIntervalMs);
    this.#refill(this.#now());
    this.#capacity = nextCapacity;
    this.#refillIntervalMs = nextInterval;
    if (this.#tokens > nextCapacity) this.#tokens = nextCapacity;
  }

  /**
   * Credit the tokens earned between the last evaluation and `nowMs`.
   *
   * The integral is piecewise: the part of the elapsed span that falls inside the throttle window
   * earns `baseRate * factor`, the rest earns `baseRate`. Splitting it this way is what lets a
   * throttle expire correctly without anything running at the moment it expires.
   *
   * A clock that jumps backwards (possible if a caller injects wall-clock time) credits nothing and
   * re-bases, rather than debiting tokens.
   */
  #refill(nowMs: number): void {
    const lastMs = this.#lastMs;
    if (!Number.isFinite(nowMs)) return;
    if (nowMs <= lastMs) {
      this.#lastMs = nowMs;
      return;
    }
    this.#lastMs = nowMs;

    const elapsed = nowMs - lastMs;
    const overlap = Math.max(
      0,
      Math.min(nowMs, this.#throttleUntilMs) - Math.max(lastMs, this.#throttleStartMs),
    );
    const full = elapsed - overlap;
    const earned = this.#baseRate * (full + overlap * this.#throttleFactor);

    const next = this.#tokens + earned;
    this.#tokens = next > this.#capacity ? this.#capacity : next;
  }
}

function requireAmount(n: number): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    throw new LighterValidationError(
      "INVALID_TOKEN_AMOUNT",
      "token amount must be a finite number > 0",
      { field: "n" },
    );
  }
  return n;
}

/** Default inflight ceiling: headroom under the documented 50 (`spec/06-websocket.md` §10.3). */
const DEFAULT_MAX_INFLIGHT: 40 = 40;

/**
 * Counting semaphore for frames awaiting a server reply.
 *
 * Non-blocking by construction: {@link tryAcquire} either takes a slot or reports that none is
 * free. There is no waiter queue and no promise here, because a queue implies a wake-up, a wake-up
 * implies a scheduled callback, and this module has none. The transport decides what to do with a
 * refusal.
 *
 * State: two integers, owned for the lifetime of the connection.
 */
export class InflightSemaphore {
  #max: number;
  #inflight = 0;

  constructor(max: number = DEFAULT_MAX_INFLIGHT) {
    this.#max = normalizeMax(max);
  }

  /** Slots currently held. May briefly exceed {@link max} after a {@link resize} downwards. */
  get inflight(): number {
    return this.#inflight;
  }

  /** Current ceiling. Never below 1. */
  get max(): number {
    return this.#max;
  }

  /** Take a slot if one is free. */
  tryAcquire(): boolean {
    if (this.#inflight >= this.#max) return false;
    this.#inflight += 1;
    return true;
  }

  /** Give a slot back. Extra releases are ignored rather than driving the count negative. */
  release(): void {
    if (this.#inflight > 0) this.#inflight -= 1;
  }

  /**
   * Change the ceiling — the response to a 30010 (too many inflight) is to shrink by ~25 %, which
   * the caller computes and passes here.
   *
   * Slots already acquired are **not** revoked: their replies are still coming, and pretending
   * otherwise would double-count when they arrive. `inflight` may therefore sit above `max` until
   * enough of them land. The floor is 1 — a ceiling of 0 would deadlock the connection permanently,
   * since nothing but a reply can release a slot and no request could ever be sent to earn one.
   */
  resize(max: number): void {
    this.#max = normalizeMax(max);
  }

  /** Drop every slot. Called on disconnect, where no outstanding reply can ever arrive. */
  releaseAll(): void {
    this.#inflight = 0;
  }
}

function normalizeMax(max: number): number {
  if (typeof max !== "number" || Number.isNaN(max)) {
    throw new LighterConfigError("max inflight must be a number", { code: "RATELIMIT_OPTION" });
  }
  // `Math.floor` keeps a fractional 25 % shrink from producing a fractional ceiling; the `max(1, …)`
  // is the deadlock floor. `Infinity` passes through both unchanged and means "unlimited".
  return Math.max(1, Math.floor(max));
}
