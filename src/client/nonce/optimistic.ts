/**
 * The default strategy: one local counter per key, seeded once from the server.
 *
 * ```text
 * lazy init   counter[k] = serverNextNonce(k) - 1
 * allocate    counter[k] += 1 ; hand out counter[k]
 * rollback    counter[k] -= 1   — only from the top slot, otherwise force a resync
 * resync      counter[k] = serverNextNonce(k) - 1
 * ```
 *
 * Seeding at `server - 1` is what makes the *first* allocated nonce equal the nonce the sequencer
 * is actually waiting for. Constructing a source performs zero network calls; each key pays one
 * `nextNonce` on its first use and none afterwards.
 *
 * The counter is a plain `bigint` under an async mutex, which is safe only because the mutex is
 * held across the network round trip — allocation, signing and submission all happen inside it.
 * That serialises one key at one transaction per round trip, which is exactly the sequencer's own
 * limit, and is why the pool rotates across keys.
 */

import { LighterConfigError, LighterNonceError, LighterValidationError } from "../../errors.js";
import { KeyPool } from "./key-pool.js";
import type {
  NextNonceClient,
  NonceKeySnapshot,
  NonceLease,
  NonceSnapshot,
  NonceSource,
} from "./types.js";
import { createLease, readNextNonce } from "./types.js";

/** What {@link OptimisticNonceSource} is constructed with. */
export interface OptimisticNonceSourceOptions {
  /** The account these counters belong to. Stamped into snapshots and checked on restore. */
  readonly accountIndex: number;
  /** The configured API key indices. Required unless {@link pool} is given. */
  readonly keys?: readonly number[];
  /** An existing pool to share instead of building one from {@link keys}. */
  readonly pool?: KeyPool;
  /** Reaches `GET /api/v1/nextNonce`. `LighterRestClient` satisfies this structurally. */
  readonly client: NextNonceClient;
  /** Opt into {@link OptimisticNonceSource.leaseBatch}. Off by default. */
  readonly pipelined?: boolean;
}

/** Mutable per-key state. Lives on the instance; there is no module-scope equivalent. */
interface KeyState {
  /**
   * The last nonce handed out, so the next allocation is `counter + 1`. `undefined` until the key
   * is seeded. May be `-1n` on a key whose server nonce is `0`.
   */
  counter: bigint | undefined;
  /** Set when the counter can no longer be trusted; the next allocation reseeds from the server. */
  dirty: boolean;
}

export class OptimisticNonceSource implements NonceSource {
  readonly kind: "optimistic" = "optimistic";
  /** The account every counter here belongs to. */
  readonly accountIndex: number;
  /** The keys this source allocates over, and their mutexes. */
  readonly pool: KeyPool;

  readonly #client: NextNonceClient;
  readonly #pipelined: boolean;
  readonly #state: Map<number, KeyState> = new Map<number, KeyState>();

  constructor(options: OptimisticNonceSourceOptions) {
    this.accountIndex = requireAccountIndex(options.accountIndex);
    this.pool = options.pool ?? new KeyPool(options.keys ?? []);
    this.#client = options.client;
    this.#pipelined = options.pipelined === true;
  }

  /**
   * Take the next slot on a rotated key, or on `preferKey` when the caller is sequencing several
   * transactions onto one key (a batch must share one key with consecutive nonces).
   *
   * The key is picked *before* the lock, so concurrent callers fan out; the seeding fetch, if any,
   * happens *inside* it, so two callers can never both observe an unseeded counter.
   */
  async lease(preferKey?: number): Promise<NonceLease> {
    const key: number = this.#select(preferKey);
    const release: () => void = await this.pool.acquire(key);
    try {
      const nonce: bigint = await this.#allocate(key);
      return createLease({
        apiKeyIndex: key,
        nonce,
        onRollback: (): void => {
          this.#rollback(key, nonce);
        },
        onRelease: release,
      });
    } catch (error: unknown) {
      // The lock must not outlive a failed allocation, or the key deadlocks on a transient
      // `nextNonce` failure.
      release();
      throw error;
    }
  }

  /**
   * Pipelined allocation: `count` slots claimed up front, so the caller can sign and send them
   * concurrently instead of one per round trip.
   *
   * Every lease comes back with `skipNonce: true`, and each transaction **must** carry L2 attribute
   * type `4` set to `1` — the sequencer would otherwise require them to arrive in order, which is
   * precisely what this mode gives up. Because the attribute participates in the transaction hash,
   * a pipelined transaction and an otherwise identical ordinary one have different hashes and
   * different signatures.
   *
   * Opt-in and off by default. How far ahead of the expected nonce a claimed slot may legally sit,
   * and whether an abandoned slot is reclaimable, is an unresolved protocol question
   * (`docs/ARCHITECTURE.md` §11, open question 20) — so keep `count` small and expect to resync.
   *
   * The key's mutex is held until **every** lease in the batch has been released, so no other
   * allocation interleaves with the batch.
   */
  async leaseBatch(count: number, preferKey?: number): Promise<readonly NonceLease[]> {
    if (!this.#pipelined) {
      throw new LighterNonceError(
        "LEASE_EXHAUSTED",
        "pipelined allocation is opt-in; construct the source with { pipelined: true }",
      );
    }
    if (!Number.isInteger(count) || count < 1) {
      throw new LighterValidationError(
        "UNSAFE_INTEGER",
        `pipelined batch size must be a positive integer, received ${String(count)}`,
        { field: "count" },
      );
    }

    const key: number = this.#select(preferKey);
    const release: () => void = await this.pool.acquire(key);
    let outstanding: number = count;
    const releaseOne: () => void = (): void => {
      outstanding -= 1;
      if (outstanding <= 0) release();
    };

    try {
      const leases: NonceLease[] = [];
      for (let i: number = 0; i < count; i += 1) {
        const nonce: bigint = await this.#allocate(key);
        leases.push(
          createLease({
            apiKeyIndex: key,
            nonce,
            skipNonce: true,
            onRollback: (): void => {
              this.#rollback(key, nonce);
            },
            onRelease: releaseOne,
          }),
        );
      }
      return Object.freeze(leases);
    } catch (error: unknown) {
      release();
      throw error;
    }
  }

  /**
   * Reseed one key from the server. Fired by an `invalid-nonce` outcome — exactly once, and never
   * by a timeout.
   *
   * Takes no lock, so it is safe to call while still holding a lease on that key, which is where
   * the failure is observed. The counter is invalidated *synchronously* so that an allocation
   * waiting for the mutex reseeds even if this fetch fails; the fetched value is applied only if
   * nobody reseeded in the meantime.
   */
  async resync(apiKeyIndex: number): Promise<void> {
    if (!this.pool.has(apiKeyIndex)) {
      throw new LighterNonceError(
        "KEY_UNKNOWN",
        `api key index ${String(apiKeyIndex)} is not in the pool`,
      );
    }
    const state: KeyState = this.#stateOf(apiKeyIndex);
    state.counter = undefined;
    state.dirty = true;
    const server: bigint = await this.#fetch(apiKeyIndex);
    if (state.dirty) {
      state.counter = server - 1n;
      state.dirty = false;
    }
  }

  /** JSON-safe projection: counters as decimal strings, because `JSON.stringify` throws on `bigint`. */
  snapshot(): NonceSnapshot {
    const keys: NonceKeySnapshot[] = [];
    for (const apiKeyIndex of this.pool.keys) {
      const state: KeyState | undefined = this.#state.get(apiKeyIndex);
      if (state === undefined) continue;
      keys.push({
        apiKeyIndex,
        ...(state.counter !== undefined ? { counter: state.counter.toString(10) } : {}),
        ...(state.dirty ? { dirty: true } : {}),
      });
    }
    return { version: 1, kind: this.kind, accountIndex: this.accountIndex, keys };
  }

  /**
   * Adopt a snapshot — the Cloudflare Worker path, where an isolate may be recycled between
   * requests and the counters were parked in Durable Object storage.
   *
   * Keys that are not in this pool are ignored rather than rejected: a pool may legitimately be
   * narrowed between runs. A cold source with no snapshot simply falls back to the lazy
   * `nextNonce` fetch, which is always safe.
   */
  restore(s: NonceSnapshot): void {
    assertSnapshot(s, this.kind, this.accountIndex);
    for (const entry of s.keys) {
      if (!this.pool.has(entry.apiKeyIndex)) continue;
      const state: KeyState = this.#stateOf(entry.apiKeyIndex);
      const counter: bigint | undefined = parseCounter(entry.counter, entry.apiKeyIndex);
      state.dirty = entry.dirty === true;
      // A dirty key reseeds on next use, so its counter is dropped rather than trusted.
      state.counter = state.dirty ? undefined : counter;
    }
  }

  /** The next nonce this key would issue, without allocating. Diagnostics only. */
  peek(apiKeyIndex: number): bigint | undefined {
    const state: KeyState | undefined = this.#state.get(apiKeyIndex);
    if (state === undefined || state.counter === undefined || state.dirty) return undefined;
    return state.counter + 1n;
  }

  #select(preferKey?: number): number {
    if (preferKey === undefined) return this.pool.rotate();
    if (!this.pool.has(preferKey)) {
      throw new LighterNonceError(
        "KEY_UNKNOWN",
        `api key index ${String(preferKey)} is not in the pool`,
      );
    }
    return preferKey;
  }

  #stateOf(apiKeyIndex: number): KeyState {
    let state: KeyState | undefined = this.#state.get(apiKeyIndex);
    if (state === undefined) {
      state = { counter: undefined, dirty: false };
      this.#state.set(apiKeyIndex, state);
    }
    return state;
  }

  /** Called with the key's mutex held. The `await` inside is why the mutex exists. */
  async #allocate(apiKeyIndex: number): Promise<bigint> {
    const state: KeyState = this.#stateOf(apiKeyIndex);
    // `dirty` always clears the counter, so an unseeded counter is the single reseed trigger.
    if (state.counter === undefined) {
      const server: bigint = await this.#fetch(apiKeyIndex);
      // A `resync()` may have landed while this fetch was in flight. Its value is the newer of the
      // two, so it wins; ours is used only if it left the counter unseeded.
      if (state.counter === undefined) {
        state.counter = server - 1n;
        state.dirty = false;
      }
    }
    const next: bigint = (state.counter as bigint) + 1n;
    state.counter = next;
    return next;
  }

  /**
   * `rollback()` is a decrement only from the top slot.
   *
   * Any other case — a lease released before an earlier one rolled back, or a pipelined slot in the
   * middle of a batch — would hand a live nonce out twice, so the key is marked dirty and reseeded
   * on its next use instead.
   */
  #rollback(apiKeyIndex: number, nonce: bigint): void {
    const state: KeyState = this.#stateOf(apiKeyIndex);
    if (!state.dirty && state.counter === nonce) {
      state.counter = nonce - 1n;
      return;
    }
    state.dirty = true;
    state.counter = undefined;
  }

  async #fetch(apiKeyIndex: number): Promise<bigint> {
    return readNextNonce(
      await this.#client.transaction.nextNonce({
        account_index: this.accountIndex,
        api_key_index: apiKeyIndex,
      }),
    );
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Shared validation                                                                                */
/* ---------------------------------------------------------------------------------------------- */

/** An account index is an integer; the protocol range is checked by the transaction validators. */
export function requireAccountIndex(accountIndex: number): number {
  if (typeof accountIndex !== "number" || !Number.isSafeInteger(accountIndex)) {
    throw new LighterConfigError(
      `accountIndex must be a safe integer, received ${String(accountIndex)}`,
    );
  }
  return accountIndex;
}

/** Reject a snapshot that belongs to another account, another strategy, or another version. */
export function assertSnapshot(s: NonceSnapshot, kind: string, accountIndex: number): void {
  if (typeof s !== "object" || s === null) {
    throw new LighterConfigError("nonce snapshot is not an object");
  }
  if (s.version !== 1) {
    throw new LighterConfigError(`unsupported nonce snapshot version ${String(s.version)}`);
  }
  if (s.kind !== kind) {
    throw new LighterConfigError(
      `nonce snapshot was taken from a "${String(s.kind)}" source, not a "${kind}" one`,
    );
  }
  if (s.accountIndex !== accountIndex) {
    throw new LighterConfigError(
      `nonce snapshot belongs to account ${String(s.accountIndex)}, not ${String(accountIndex)}`,
    );
  }
  if (!Array.isArray(s.keys)) {
    throw new LighterConfigError("nonce snapshot has no keys array");
  }
}

/**
 * Parse a snapshot counter. Decimal string in, `bigint` out; `-1` is legal (a key whose server
 * nonce is `0` has issued nothing), anything below that is corruption.
 */
export function parseCounter(counter: string | undefined, apiKeyIndex: number): bigint | undefined {
  if (counter === undefined) return undefined;
  if (typeof counter !== "string" || !/^-?[0-9]+$/.test(counter)) {
    throw new LighterConfigError(
      `nonce snapshot for key ${String(apiKeyIndex)} carries a non-numeric counter`,
    );
  }
  const value: bigint = BigInt(counter);
  if (value < -1n) {
    throw new LighterValidationError(
      "NONCE_TOO_LOW",
      `nonce snapshot for key ${String(apiKeyIndex)} carries a counter below -1`,
      { field: "nonce", bound: -1n },
    );
  }
  return value;
}
