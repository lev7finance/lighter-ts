/**
 * The vocabulary of nonce allocation: the lease, the source, the JSON-safe snapshot, and the
 * failure classifier the submit path branches on.
 *
 * A nonce is scoped to `(accountIndex, apiKeyIndex)` and must be strictly increasing and gapless
 * per key. Allocate one twice and the second transaction is rejected; skip one and *every*
 * subsequent transaction on that key is rejected until a resync. Both failure modes are quiet, so
 * the design here is deliberately narrow:
 *
 * 1. **A lease owns the per-key mutex.** It is taken before allocation and released only after the
 *    transaction has been signed *and* submitted, which is what makes transactions on one key
 *    reach the sequencer in nonce order. `Symbol.dispose` makes `using lease = await src.lease()`
 *    correct by construction.
 * 2. **Doing nothing is the safe default.** A lease that is released without `commit()` or
 *    `rollback()` burns its slot. That is exactly the behaviour a network timeout needs — the
 *    transaction may well have landed, so returning the slot to the pool would let the next send
 *    collide with a transaction that is already in the sequencer.
 * 3. **Nonces are `bigint`.** `nextNonce` returns an `int64` and `JSON.parse` hands back a
 *    `number`; the conversion goes through {@link readNextNonce}, which rejects anything that is
 *    not a safe non-negative integer rather than letting a float through (risk R9).
 *
 * See `docs/ARCHITECTURE.md` ADR-14 and `docs/spec/07-high-level-client.md` §4.
 */

import { isLighterError, LighterValidationError, RESULT_OK } from "../../errors.js";
import type { KeyPool } from "./key-pool.js";

/* ---------------------------------------------------------------------------------------------- */
/* Leases                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * One allocated slot, and the per-key mutex that protects it.
 *
 * The contract is: allocate, sign, submit, then **exactly one** of `commit()` / `rollback()` /
 * nothing, then always `release()` — in a `finally`, or by declaring the lease with `using`. A
 * thrown signer or a rejected `fetch` that skips `release()` deadlocks the key forever.
 *
 * `commit()` and `rollback()` are terminal: the first of the two wins and later calls are ignored.
 * `release()` is idempotent. The mutex is **not** reentrant — a lease holder must never call
 * `lease()` again for the same key.
 */
export interface NonceLease extends Disposable {
  /** The key this slot belongs to. Sign with exactly this index. */
  readonly apiKeyIndex: number;
  /** The slot. Sign with exactly this value. */
  readonly nonce: bigint;
  /**
   * True when this slot was claimed out of order (pipelined mode), so the transaction must carry
   * L2 attribute type `4` set to `1`. False for every ordinary lease.
   */
  readonly skipNonce: boolean;
  /** The sequencer accepted the transaction. */
  commit(): void;
  /**
   * The transaction was **definitively** rejected and never reached the sequencer's state, so the
   * slot returns to the pool.
   *
   * This is not a plain decrement: it is a decrement only when this lease still holds the highest
   * issued nonce for its key. Rolling back a middle slot would hand a live nonce out twice, so any
   * other case forces a resync on the key's next use instead.
   *
   * Never call this after a timeout. See {@link classifyOutcome}.
   */
  rollback(): void;
  /** Release the mutex. Always, via `finally` or `using`. Idempotent. */
  release(): void;
}

/** What {@link createLease} needs in order to build a {@link NonceLease}. */
export interface LeaseSpec {
  readonly apiKeyIndex: number;
  readonly nonce: bigint;
  /** Defaults to `false`. */
  readonly skipNonce?: boolean;
  /** Runs at most once, on the first `commit()`. */
  readonly onCommit?: () => void;
  /** Runs at most once, on the first `rollback()`. */
  readonly onRollback?: () => void;
  /** Runs at most once, on the first `release()`. Releases the mutex. */
  readonly onRelease: () => void;
}

/*
 * `Symbol.dispose` is `undefined` on Node 20 and on older Safari, both of which this package
 * supports. Reading it defensively and attaching the method with `defineProperty` keeps the module
 * importable there; on a runtime that has the symbol, `using lease = await src.lease()` works.
 *
 * Note what is *not* done: `Symbol.dispose ??= Symbol(...)`. Mutating a global at module scope is
 * an import side effect and this package ships `"sideEffects": false`. Defining a property on an
 * object we just created is not observable outside this module.
 */
const DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;

/**
 * Build a lease. The three callbacks each fire at most once, whatever the caller does.
 *
 * The returned object is frozen: a lease is a capability, and a caller that could rewrite `nonce`
 * after allocation would defeat the entire unit.
 */
export function createLease(spec: LeaseSpec): NonceLease {
  let settled: boolean = false;
  let released: boolean = false;

  const release: () => void = (): void => {
    if (released) return;
    released = true;
    spec.onRelease();
  };

  const lease: Omit<NonceLease, typeof Symbol.dispose> = {
    apiKeyIndex: spec.apiKeyIndex,
    nonce: spec.nonce,
    skipNonce: spec.skipNonce ?? false,
    commit(): void {
      if (settled) return;
      settled = true;
      if (spec.onCommit !== undefined) spec.onCommit();
    },
    rollback(): void {
      if (settled) return;
      settled = true;
      if (spec.onRollback !== undefined) spec.onRollback();
    },
    release,
  };

  if (typeof DISPOSE === "symbol") {
    Object.defineProperty(lease, DISPOSE, {
      value: release,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  }

  return Object.freeze(lease) as NonceLease;
}

/* ---------------------------------------------------------------------------------------------- */
/* Sources                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** Which allocation strategy a source implements. */
export type NonceSourceKind = "optimistic" | "server" | "manual";

/**
 * Where nonces come from.
 *
 * Implementations hold their state on the instance — never at module scope — so N clients for N
 * accounts or chains coexist without interfering (`docs/decisions.md` D8).
 */
export interface NonceSource {
  /** Which strategy this is. */
  readonly kind: NonceSourceKind;
  /**
   * Take the next slot, rotating across the key pool unless `preferKey` pins one.
   *
   * Resolves once the key's mutex is held; the caller owns that mutex until it releases the lease.
   */
  lease(preferKey?: number): Promise<NonceLease>;
  /**
   * Hard resync of one key against the server. Fired by an `invalid-nonce` outcome, exactly once —
   * never by a timeout.
   *
   * Does **not** take the key's mutex, so it is safe to call while holding a lease on that key.
   */
  resync(apiKeyIndex: number): Promise<void>;
  /** JSON-safe projection of every key's state. */
  snapshot(): NonceSnapshot;
  /** Adopt a previously captured snapshot. */
  restore(s: NonceSnapshot): void;
}

/* ---------------------------------------------------------------------------------------------- */
/* Snapshots                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * One key's state, JSON-safe.
 *
 * `counter` is a **decimal string**, not a `bigint`: `JSON.stringify` throws on `bigint`, and this
 * structure exists to be parked in Durable Object storage between requests.
 */
export interface NonceKeySnapshot {
  readonly apiKeyIndex: number;
  /**
   * The last *issued* nonce, so the next allocation is `counter + 1`. Absent when the key has
   * never been used — a cold isolate then falls back to a lazy `nextNonce` fetch, which is always
   * safe. May be `"-1"`: a key whose server nonce is `0` has issued nothing yet.
   */
  readonly counter?: string;
  /** When true, the key is resynced against the server before its next allocation. */
  readonly dirty?: boolean;
  /** Server strategy only: epoch ms at which this key was last released. */
  readonly lastUsedAtMs?: number;
  /** Server strategy only: the pacing interval currently in force for this key. */
  readonly paceMs?: number;
}

/**
 * Everything a source needs to resume where it left off.
 *
 * `accountIndex` and `kind` are stamped in and checked on {@link NonceSource.restore}: restoring
 * one account's counters into another, or an optimistic snapshot into a server source, is a
 * corruption source rather than a convenience.
 */
export interface NonceSnapshot {
  readonly version: 1;
  readonly kind: NonceSourceKind;
  readonly accountIndex: number;
  readonly keys: readonly NonceKeySnapshot[];
}

/* ---------------------------------------------------------------------------------------------- */
/* The one network call this unit makes                                                             */
/* ---------------------------------------------------------------------------------------------- */

/**
 * `GET /api/v1/nextNonce` as it comes off the wire.
 *
 * `nonce` is optional because the server is Go with `omitempty`: a key whose next nonce is `0` —
 * every freshly registered key — omits the field entirely. Absent therefore means `0`, not
 * "missing". See {@link readNextNonce}.
 */
export interface NextNonceResponse {
  code?: number;
  message?: string;
  nonce?: number;
}

/**
 * The slice of the grouped REST client this unit uses.
 *
 * Structural on purpose: `LighterRestClient` satisfies it, and so does a two-line fake, so no test
 * in this unit touches the network.
 */
export interface NextNonceClient {
  readonly transaction: {
    nextNonce(params: {
      account_index: number;
      api_key_index: number;
    }): Promise<NextNonceResponse>;
  };
}

/**
 * Read the `nonce` field of a `nextNonce` response as a `bigint`.
 *
 * An absent field is `0` (Go `omitempty`). A present field must be a non-negative safe integer:
 * `JSON.parse` yields a `number`, and an `int64` beyond 2^53 or a fractional value would otherwise
 * be silently truncated by `BigInt()` — or worse, throw a bare `RangeError` from deep inside the
 * allocator.
 */
export function readNextNonce(response: NextNonceResponse): bigint {
  const raw: number | undefined = response.nonce;
  if (raw === undefined) return 0n;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
    throw new LighterValidationError(
      "UNSAFE_INTEGER",
      `nextNonce returned a value that is not a safe integer: ${String(raw)}`,
      { field: "nonce" },
    );
  }
  if (raw < 0) {
    throw new LighterValidationError("NONCE_TOO_LOW", "nextNonce returned a negative nonce", {
      field: "nonce",
      bound: 0n,
    });
  }
  return BigInt(raw);
}

/* ---------------------------------------------------------------------------------------------- */
/* Outcome classification                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What happened to a transaction, from the nonce manager's point of view.
 *
 * - `accepted` — the sequencer took it. The slot is spent.
 * - `rejected` — definitively refused, or never sent at all. The slot returns to the pool:
 *   `lease.rollback()`.
 * - `invalid-nonce` — the sequencer disagrees with our counter. Exactly one `resync()`, and no
 *   rollback: a rollback would move a counter that is already wrong in an unknown direction.
 * - `indeterminate` — we do not know whether it landed. **Burn the slot**: release the lease and do
 *   nothing else. This is the case the reference gets wrong (it rolls back), and a rollback here
 *   makes the next send on the key collide with a transaction that may already be in the
 *   sequencer.
 */
export type NonceOutcome = "accepted" | "rejected" | "invalid-nonce" | "indeterminate";

/**
 * Domain codes known to mean "your nonce is not the one I expected".
 *
 * **Empty, and deliberately so.** No capture in this repository has produced a numeric code for
 * this condition, and the one thing that must not happen is matching on message text: `message`
 * carries trailing whitespace and is not stable (`docs/protocol-notes.md` §8.1.1). Supply the code
 * once it is observed, via {@link createOutcomeClassifier}, rather than guessing here — an invented
 * code that matches some *other* failure would turn ordinary rejections into resyncs.
 */
export const INVALID_NONCE_API_CODES: readonly number[] = Object.freeze([]);

/** Options for {@link classifyOutcome}. */
export interface ClassifyOptions {
  /** Domain codes to read as `invalid-nonce`. Defaults to {@link INVALID_NONCE_API_CODES}. */
  readonly invalidNonceCodes?: readonly number[];
}

/**
 * Classify the result of a submission.
 *
 * Accepts either a thrown value or a parsed response body, because the two channels are
 * independent: a `sendTx` can fail by rejecting *or* by resolving with a non-200 `code`
 * (`docs/protocol-notes.md` §8.1). `undefined`, `null`, and a body whose `code` is `200` or absent
 * are all `accepted`.
 *
 * The rules, in order:
 *
 * | Input | Outcome | Why |
 * | --- | --- | --- |
 * | `LighterTimeoutError`, `LighterTransportError` | `indeterminate` | A reset or an abort can happen *after* the request was written. |
 * | Anything named `AbortError` / `TimeoutError` | `indeterminate` | Same, from a non-SDK layer. |
 * | `LighterError` of kind `ws` | `indeterminate` | The frame may already be on the wire. |
 * | `LighterApiError` with a listed code | `invalid-nonce` | Exactly one resync. |
 * | Any other `LighterApiError` | `rejected` | The server made a decision. |
 * | `LighterNonceError` with code `INVALID_NONCE` | `invalid-nonce` | Raised by our own submit path. |
 * | Any other local `LighterError` | `rejected` | Validation, math, signature, config: nothing was sent. |
 * | `LighterBlockedError` | `rejected` | The CDN answered; the origin never saw the request. |
 * | A body with a non-200 `code` | `invalid-nonce` or `rejected` | Same code rules. |
 * | Anything else | `indeterminate` | An unrecognised failure is not evidence that the transaction did not land. |
 *
 * The last row is the important default: when in doubt, do nothing.
 */
export function classifyOutcome(e: unknown, options?: ClassifyOptions): NonceOutcome {
  if (e === undefined || e === null) return "accepted";

  const invalidCodes: readonly number[] = options?.invalidNonceCodes ?? INVALID_NONCE_API_CODES;

  if (isLighterError(e)) {
    const error: Record<string, unknown> = e as unknown as Record<string, unknown>;
    const kind: unknown = error["kind"];
    if (kind === "timeout" || kind === "network" || kind === "ws") return "indeterminate";
    const code: unknown = error["code"];
    if (kind === "nonce") return code === "INVALID_NONCE" ? "invalid-nonce" : "rejected";
    if (typeof code === "number" && invalidCodes.includes(code)) return "invalid-nonce";
    return "rejected";
  }

  if (typeof e === "object") {
    const candidate: Record<string, unknown> = e as Record<string, unknown>;
    const name: unknown = candidate["name"];
    if (name === "AbortError" || name === "TimeoutError") return "indeterminate";
    // A response body, not an error: no `name`, no `stack`. `DOMException` carries both, and a
    // host system error carries a *string* `code`, so neither is mistaken for a body here.
    if (name === undefined && candidate["stack"] === undefined) {
      const code: unknown = candidate["code"];
      if (code === undefined || code === RESULT_OK) return "accepted";
      if (typeof code === "number") {
        return invalidCodes.includes(code) ? "invalid-nonce" : "rejected";
      }
    }
  }

  return "indeterminate";
}

/**
 * Bind {@link classifyOutcome} to a configured code set, so the submit path carries one function
 * rather than an options object threaded through every call site.
 */
export function createOutcomeClassifier(
  invalidNonceCodes?: readonly number[],
): (e: unknown) => NonceOutcome {
  const codes: readonly number[] = Object.freeze([...(invalidNonceCodes ?? INVALID_NONCE_API_CODES)]);
  return (e: unknown): NonceOutcome => classifyOutcome(e, { invalidNonceCodes: codes });
}

/* ---------------------------------------------------------------------------------------------- */
/* Construction options                                                                             */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The union of everything the three strategies can be constructed with — the argument to
 * `createNonceSource`.
 *
 * Each concrete class narrows this to what it actually needs, so `new OptimisticNonceSource({...})`
 * will not compile without a client while `new ManualNonceSource({...})` will not accept one.
 */
export interface NonceSourceOptions {
  /**
   * The account these nonces belong to. Stamped into {@link NonceSnapshot} and checked on restore,
   * because a nonce is meaningless — and dangerous — outside its `(account, key)` pair.
   */
  readonly accountIndex: number;
  /** The configured API key indices. Ignored when {@link pool} is supplied. */
  readonly keys?: readonly number[];
  /** An existing pool to share, rather than one built from {@link keys}. */
  readonly pool?: KeyPool;
  /** Reaches `GET /api/v1/nextNonce`. Required by the optimistic and server strategies. */
  readonly client?: NextNonceClient;
  /** Opt into pipelined allocation. Off by default; see `OptimisticNonceSource.leaseBatch`. */
  readonly pipelined?: boolean;
  /** Server strategy: how long to wait before reusing a key with no prediction. Default `350`. */
  readonly defaultPaceMs?: number;
  /** Injectable clock. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable delay. Defaults to a `setTimeout`-backed sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}
