/**
 * The paranoid strategy: every allocation re-queries `GET /api/v1/nextNonce` and uses the returned
 * value verbatim.
 *
 * Correct by construction — there is no local counter to drift — at the cost of one extra round
 * trip per transaction. The catch is that `nextNonce` reflects *sequencer* state, which lags the
 * send: query it again too soon after a submission and it returns the nonce that was just used.
 * So the key is paced. The reference documents a flat 350 ms floor before reusing a key; the send
 * response's `predicted_execution_time_ms` is a tighter, per-key bound, and
 * {@link ServerNonceSource.notifyPredictedExecutionMs} is how the submit path feeds it back.
 *
 * Pacing waits **inside** the key's mutex, so a paced key holds up only itself and the pool keeps
 * fanning out across the others.
 */

import { LighterNonceError } from "../../errors.js";
import { KeyPool } from "./key-pool.js";
import { assertSnapshot, requireAccountIndex } from "./optimistic.js";
import type {
  NextNonceClient,
  NonceKeySnapshot,
  NonceLease,
  NonceSnapshot,
  NonceSource,
} from "./types.js";
import { createLease, readNextNonce } from "./types.js";

/**
 * How long to wait before reusing a key when no prediction has been fed back.
 *
 * From the reference's own guidance ("wait at least 350 ms before reusing the same api key").
 */
export const DEFAULT_PACE_MS: 350 = 350;

/** Upper bound on a fed-back prediction, so one absurd telemetry value cannot stall a key. */
export const MAX_PACE_MS: 60_000 = 60_000;

/** What {@link ServerNonceSource} is constructed with. */
export interface ServerNonceSourceOptions {
  readonly accountIndex: number;
  /** The configured API key indices. Required unless {@link pool} is given. */
  readonly keys?: readonly number[];
  /** An existing pool to share instead of building one from {@link keys}. */
  readonly pool?: KeyPool;
  /** Reaches `GET /api/v1/nextNonce`. `LighterRestClient` satisfies this structurally. */
  readonly client: NextNonceClient;
  /** Pacing interval for a key with no prediction. Defaults to {@link DEFAULT_PACE_MS}. */
  readonly defaultPaceMs?: number;
  /** Injectable clock. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable delay. Defaults to a single-shot `setTimeout`. Inject it and tests take no time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Mutable per-key pacing state. Instance-scoped. */
interface PaceState {
  /** Epoch ms at which the key's last lease was released, i.e. when its transaction was sent. */
  lastUsedAtMs: number | undefined;
  /** The interval currently in force, from the last prediction fed back for this key. */
  paceMs: number | undefined;
}

export class ServerNonceSource implements NonceSource {
  readonly kind: "server" = "server";
  readonly accountIndex: number;
  readonly pool: KeyPool;

  readonly #client: NextNonceClient;
  readonly #defaultPaceMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #state: Map<number, PaceState> = new Map<number, PaceState>();

  constructor(options: ServerNonceSourceOptions) {
    this.accountIndex = requireAccountIndex(options.accountIndex);
    this.pool = options.pool ?? new KeyPool(options.keys ?? []);
    this.#client = options.client;
    this.#defaultPaceMs = clampPace(options.defaultPaceMs) ?? DEFAULT_PACE_MS;
    this.#now = options.now ?? ((): number => Date.now());
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Wait out the key's pacing interval, then take whatever nonce the server names.
   *
   * `rollback()` is a no-op here: the slot lives on the server, so a rejected transaction leaves
   * `nextNonce` exactly where it was and the next allocation gets the same value back.
   */
  async lease(preferKey?: number): Promise<NonceLease> {
    const key: number = this.#select(preferKey);
    const release: () => void = await this.pool.acquire(key);
    try {
      await this.#pace(key);
      const nonce: bigint = await this.#fetch(key);
      return createLease({
        apiKeyIndex: key,
        nonce,
        onRelease: (): void => {
          // Stamped on release rather than on allocation: the interval that matters is the one
          // since the transaction was *sent*, and the caller sends while holding the lease.
          this.#stateOf(key).lastUsedAtMs = this.#now();
          release();
        },
      });
    } catch (error: unknown) {
      release();
      throw error;
    }
  }

  /**
   * Feed back `predicted_execution_time_ms` from a send response, so this key's next allocation is
   * paced by the sequencer's own estimate rather than by the blunt default.
   *
   * Telemetry must never break the send path, so a value that is not a finite non-negative number
   * is ignored rather than thrown; anything above {@link MAX_PACE_MS} is clamped.
   */
  notifyPredictedExecutionMs(apiKeyIndex: number, ms: number): void {
    if (!this.pool.has(apiKeyIndex)) return;
    const paceMs: number | undefined = clampPace(ms);
    if (paceMs === undefined) return;
    this.#stateOf(apiKeyIndex).paceMs = paceMs;
  }

  /**
   * Nothing to resync: every allocation already re-queries the server, so there is no cached
   * counter that could disagree with it. Present because {@link NonceSource} requires it, and
   * because a caller switching strategies should not have to switch failure handling too.
   */
  async resync(apiKeyIndex: number): Promise<void> {
    if (!this.pool.has(apiKeyIndex)) {
      throw new LighterNonceError(
        "KEY_UNKNOWN",
        `api key index ${String(apiKeyIndex)} is not in the pool`,
      );
    }
  }

  /** Pacing state only — there are no counters in this strategy. JSON-safe. */
  snapshot(): NonceSnapshot {
    const keys: NonceKeySnapshot[] = [];
    for (const apiKeyIndex of this.pool.keys) {
      const state: PaceState | undefined = this.#state.get(apiKeyIndex);
      if (state === undefined) continue;
      keys.push({
        apiKeyIndex,
        ...(state.lastUsedAtMs !== undefined ? { lastUsedAtMs: state.lastUsedAtMs } : {}),
        ...(state.paceMs !== undefined ? { paceMs: state.paceMs } : {}),
      });
    }
    return { version: 1, kind: this.kind, accountIndex: this.accountIndex, keys };
  }

  restore(s: NonceSnapshot): void {
    assertSnapshot(s, this.kind, this.accountIndex);
    for (const entry of s.keys) {
      if (!this.pool.has(entry.apiKeyIndex)) continue;
      const state: PaceState = this.#stateOf(entry.apiKeyIndex);
      state.lastUsedAtMs =
        typeof entry.lastUsedAtMs === "number" && Number.isFinite(entry.lastUsedAtMs)
          ? entry.lastUsedAtMs
          : undefined;
      state.paceMs = clampPace(entry.paceMs);
    }
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

  #stateOf(apiKeyIndex: number): PaceState {
    let state: PaceState | undefined = this.#state.get(apiKeyIndex);
    if (state === undefined) {
      state = { lastUsedAtMs: undefined, paceMs: undefined };
      this.#state.set(apiKeyIndex, state);
    }
    return state;
  }

  async #pace(apiKeyIndex: number): Promise<void> {
    const state: PaceState = this.#stateOf(apiKeyIndex);
    if (state.lastUsedAtMs === undefined) return;
    const interval: number = state.paceMs ?? this.#defaultPaceMs;
    const waitMs: number = state.lastUsedAtMs + interval - this.#now();
    if (waitMs > 0) await this.#sleep(waitMs);
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

/** `undefined` for anything unusable, so a caller can `?? default` it. */
function clampPace(ms: number | undefined): number | undefined {
  if (ms === undefined) return undefined;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(ms, MAX_PACE_MS);
}

/**
 * One single-shot timer per wait. Nothing recurring is ever scheduled and no handle is detached
 * from the event loop, so a Durable Object can hibernate between requests.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, ms);
  });
}
