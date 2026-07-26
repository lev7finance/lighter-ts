/**
 * Round-robin selection over the configured API keys, plus one non-reentrant mutex per key.
 *
 * Two rules make this small class load-bearing:
 *
 * 1. **The key is chosen outside the lock.** {@link KeyPool.rotate} is synchronous and takes
 *    nothing, so concurrent callers fan out across the keys. Rotating *inside* a lock would
 *    serialise the whole account onto one key and delete the entire reason multi-key support
 *    exists — throughput on one key is bounded at one transaction per round trip by nonce
 *    ordering.
 * 2. **The mutex is required even though JavaScript is single-threaded.** Allocation reads a
 *    counter, `await`s `nextNonce` on first use, and writes the counter back. `await` yields, so
 *    two concurrent `lease()` calls interleave at that point and both return the same nonce.
 *    "Single-threaded" is not a substitute for a lock; it only means the interleaving happens at
 *    known points.
 *
 * The lock is a promise chain: each waiter awaits its immediate predecessor's release, which makes
 * it FIFO — the property that turns "gapless per key" into "contiguous in the order the leases
 * were requested".
 */

import { LighterConfigError, LighterNonceError, LighterValidationError } from "../../errors.js";
import { MAX_API_KEY_INDEX, MIN_API_KEY_INDEX, NIL_API_KEY_INDEX } from "../../tx/constants.js";

/** Shared, already-settled head of every chain. Immutable, so sharing one is safe. */
const RESOLVED: Promise<void> = Promise.resolve();

/**
 * The configured API keys of one account, and their locks.
 *
 * Construction is pure: no I/O, no clock, no randomness. The only state is the rotation cursor and
 * the map of chain tails, both of which live on the instance — never at module scope, so N pools
 * for N accounts coexist (`docs/decisions.md` D8).
 */
export class KeyPool {
  /** The configured indices, in the order they were given. Frozen. */
  readonly keys: readonly number[];

  /** Index into {@link keys} of the key {@link rotate} will return next. Starts at `0`. */
  #cursor: number = 0;

  /**
   * Per key, a promise that settles when the newest waiter releases. A waiter awaits the tail it
   * displaced, so the chain is FIFO. The entry is deleted once the tail it holds has been
   * released, which keeps an idle pool from retaining settled promises.
   */
  readonly #tail: Map<number, Promise<void>> = new Map<number, Promise<void>>();

  /**
   * @param keys At least one index, each an integer in `[0, 254]`, no duplicates.
   *
   * `255` is {@link NIL_API_KEY_INDEX} — the "let the SDK choose" sentinel, never a signing key —
   * so it is rejected here rather than allowed to become a real allocation.
   */
  constructor(keys: readonly number[]) {
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new LighterConfigError("a key pool needs at least one api key index");
    }
    const seen: Set<number> = new Set<number>();
    for (const key of keys) {
      if (typeof key !== "number" || !Number.isInteger(key)) {
        throw new LighterConfigError(`api key index must be an integer, received ${String(key)}`);
      }
      if (key < MIN_API_KEY_INDEX) {
        throw new LighterValidationError(
          "API_KEY_INDEX_TOO_LOW",
          `ApiKeyIndex should not be less than ${String(MIN_API_KEY_INDEX)}`,
          { field: "ApiKeyIndex", bound: MIN_API_KEY_INDEX },
        );
      }
      if (key > MAX_API_KEY_INDEX) {
        throw new LighterValidationError(
          "API_KEY_INDEX_TOO_HIGH",
          key === NIL_API_KEY_INDEX
            ? `${String(NIL_API_KEY_INDEX)} is the nil api key index, not a signing key`
            : `ApiKeyIndex should not be larger than ${String(MAX_API_KEY_INDEX)}`,
          { field: "ApiKeyIndex", bound: MAX_API_KEY_INDEX },
        );
      }
      if (seen.has(key)) {
        throw new LighterConfigError(`duplicate api key index ${String(key)} in the pool`);
      }
      seen.add(key);
    }
    this.keys = Object.freeze([...keys]);
  }

  /** How many keys the pool holds. */
  get size(): number {
    return this.keys.length;
  }

  /** Whether an index is one this pool manages. */
  has(apiKeyIndex: number): boolean {
    return this.keys.includes(apiKeyIndex);
  }

  /**
   * The next key, round-robin, **starting at `keys[0]`**.
   *
   * Call this outside any lock. With a single key it is the identity. (The reference
   * pre-increments and so hands back `keys[1]` first; harmless, pointless, not copied.)
   */
  rotate(): number {
    const key: number | undefined = this.keys[this.#cursor];
    this.#cursor = (this.#cursor + 1) % this.keys.length;
    // Unreachable: `#cursor` is always a valid index. The guard exists because
    // `noUncheckedIndexedAccess` is on and silently coercing would hide a real bug.
    if (key === undefined) throw new LighterConfigError("key pool rotation went out of range");
    return key;
  }

  /**
   * Take the mutex for one key. Resolves once every earlier acquirer has released.
   *
   * The returned function is the release; it is idempotent, and it must run in a `finally`. A
   * caller that drops it deadlocks the key for the lifetime of the pool.
   *
   * Not reentrant: calling this again for a key you already hold waits forever.
   */
  async acquire(apiKeyIndex: number): Promise<() => void> {
    if (!this.has(apiKeyIndex)) {
      throw new LighterNonceError(
        "KEY_UNKNOWN",
        `api key index ${String(apiKeyIndex)} is not in the pool`,
      );
    }

    // Everything up to the first `await` runs synchronously at call time, so the chain is ordered
    // by call order rather than by scheduling luck.
    const previous: Promise<void> = this.#tail.get(apiKeyIndex) ?? RESOLVED;
    let signal: () => void = (): void => {};
    const held: Promise<void> = new Promise<void>((resolve: () => void): void => {
      signal = resolve;
    });
    this.#tail.set(apiKeyIndex, held);

    await previous;

    let done: boolean = false;
    return (): void => {
      if (done) return;
      done = true;
      // Only the newest waiter's tail is worth clearing; an older one has already been displaced.
      if (this.#tail.get(apiKeyIndex) === held) this.#tail.delete(apiKeyIndex);
      signal();
    };
  }

  /** Whether a key is currently locked — for diagnostics and tests, never for control flow. */
  isLocked(apiKeyIndex: number): boolean {
    return this.#tail.has(apiKeyIndex);
  }
}
