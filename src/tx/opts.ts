/**
 * The four things every transaction needs that are not part of its own payload — who is sending it,
 * with which key, at which nonce, and until when — plus the small value helpers that go with them.
 *
 * ## The clock lives here and nowhere else
 *
 * `expiredAt` is the only field in the whole codec whose default depends on the current time. That
 * dependency is confined to {@link TransactOpts.now}, an injected `() => number` defaulting to
 * `Date.now`. Everything below the builders — schemas, hashing, serialisation, signing — is
 * clock-free, which is what makes an air-gapped signer and a replayable conformance vector possible
 * at all. A builder that reached for `Date.now()` directly would make every one of the 38 rows of
 * `conformance/vectors/tx.json` unreproducible.
 *
 * Two rules follow, and both are asserted in the tests:
 *
 * - **`now` is called exactly once, and only when `expiredAt` is absent.** Supplying `expiredAt`
 *   must not read the clock at all; a throwing stub proves it.
 * - **The default is `now() + 599_000` milliseconds.** Ten minutes minus one second. Not `600_000`,
 *   and not seconds — the protocol's `ExpiredAt` is a Unix **millisecond** timestamp, so an
 *   accidental seconds value expires the transaction in 1970 and the sequencer rejects it with an
 *   error that names the field but not the unit.
 *
 * ## Attributes are normalised at construction
 *
 * `spec/04-tx-types.md` §6.7, deviation #1: entries whose value equals their registry nil value are
 * **dropped here**, before the transaction object exists. The reference's Go API keeps them, so its
 * JSON can carry `{"2":0}` for an option its own hash ignores; dropping makes the emitted document
 * and the signed bytes describe the same transaction, and is a strict subset of what the sequencer
 * accepts.
 *
 * The full §6.2 rule set runs on the **raw** map first, so a caller who supplies five entries — one
 * of them nil — still gets `TOO_MANY_ATTRIBUTES` rather than having the over-count silently
 * normalised away.
 *
 * An empty map and an absent map are indistinguishable downstream: `aggregateTxHash` treats both as
 * the no-attribute branch and `attributesToJson` renders both as `null`. So the resolved options
 * always carry a map, and no builder has to decide whether to set the property.
 */

import { LighterValidationError } from "../errors.js";
import { hexToBytes, utf8ToBytes } from "../util/bytes.js";
import { type TxAttributes, normalizeAttributes, validateAttributes } from "./attributes.js";
import { type I64, type U8, i64 } from "./brands.js";
import { MEMO_LENGTH } from "./constants.js";

/**
 * The default transaction lifetime in **milliseconds**: ten minutes minus one second.
 *
 * The odd second is the reference's, not a rounding: sequencer-side expiry is compared against a
 * clock that may be slightly ahead, and 599 seconds keeps a transaction inside the ten-minute
 * window that the API documents even when the two clocks disagree by a few hundred milliseconds.
 */
export const DEFAULT_TX_EXPIRY_MS: 599_000 = 599_000;

/** Milliseconds per minute, hour and day. Written out so no call site multiplies by hand. */
const MS_PER_MINUTE: 60_000 = 60_000;
const MS_PER_HOUR: 3_600_000 = 3_600_000;
const MS_PER_DAY: 86_400_000 = 86_400_000;

/**
 * Everything a builder needs that is not part of the transaction's own payload.
 *
 * `accountIndex`, `apiKeyIndex` and `nonce` are required because none of them has a safe default:
 * a wrong account index signs for someone else's account, and a guessed nonce is either rejected or
 * replaces a live transaction. Nonce *allocation* is an L5 concern — nothing here reaches a
 * network.
 */
export interface TransactOpts {
  /** The signing account. `[-1, 2^48−2]`; `-1` is `MinAccountIndex`, a legal value. */
  readonly accountIndex: I64;
  /** The API key slot signing this transaction. `[0, 254]`, or `255` on `L2CancelAllOrders`. */
  readonly apiKeyIndex: U8;
  /** Per-`(account, apiKey)` sequence number. Hash element 2. */
  readonly nonce: I64;
  /** Unix **milliseconds**. Defaults to `now() + `{@link DEFAULT_TX_EXPIRY_MS}. */
  readonly expiredAt?: I64 | undefined;
  /** The `L2TxAttributes` side-channel. Nil-valued entries are dropped; see the module header. */
  readonly attributes?: TxAttributes | undefined;
  /** Default `true`. Governs every SDK tightening — see `src/tx/validate/*`. */
  readonly strict?: boolean | undefined;
  /**
   * Injected clock, default `() => Date.now()`. The only clock read anywhere in the codec, and it
   * is not read at all when {@link TransactOpts.expiredAt} is supplied.
   */
  readonly now?: (() => number) | undefined;
}

/**
 * {@link TransactOpts} with every default applied: no optional fields, no clock left to read.
 *
 * `attributes` is always present and may be the empty map, which hashes and serialises exactly as
 * an absent one.
 */
export interface ResolvedTransactOpts {
  readonly accountIndex: I64;
  readonly apiKeyIndex: U8;
  readonly nonce: I64;
  readonly expiredAt: I64;
  readonly attributes: TxAttributes;
  readonly strict: boolean;
}

/**
 * Apply the defaults once, at the top of every builder.
 *
 * @throws {LighterValidationError} the §6.2 attribute code for an invalid attribute map, or
 * `UNSAFE_INTEGER` if the injected clock returns a non-integral or unsafe number.
 */
export function resolveOpts(opts: TransactOpts): ResolvedTransactOpts {
  // The §6.2 rules run against what the caller wrote, before nil-dropping can hide an over-count.
  validateAttributes(opts.attributes);
  return {
    accountIndex: opts.accountIndex,
    apiKeyIndex: opts.apiKeyIndex,
    nonce: opts.nonce,
    // `??` is lazy on the right, so the clock is untouched whenever `expiredAt` was supplied — and
    // `0n` is a value, not an absence, so `IOC_EXPIRY` survives.
    expiredAt: opts.expiredAt ?? i64(readClock(opts.now) + DEFAULT_TX_EXPIRY_MS),
    attributes: normalizeAttributes(opts.attributes),
    strict: opts.strict !== false,
  };
}

/**
 * Read the injected clock, defaulting to `Date.now`.
 *
 * @throws {LighterValidationError} `UNSAFE_INTEGER` when the clock returns something that is not a
 * safe integer — a `performance.now()`-style fractional value would otherwise reach `i64` as a
 * fraction and be reported against `expiredAt`, several frames from the actual mistake.
 */
function readClock(now?: (() => number) | undefined): number {
  const millis: number = (now ?? Date.now)();
  if (!Number.isSafeInteger(millis)) {
    throw new LighterValidationError(
      "UNSAFE_INTEGER",
      `opts.now returned ${String(millis)}, which is not a safe integer number of milliseconds`,
      { field: "ExpiredAt" },
    );
  }
  return millis;
}

/**
 * An absolute `expiredAt` a fixed duration from now, for callers who think in durations.
 *
 * ```ts
 * buildCreateOrder(req, { ...opts, expiredAt: expiryIn({ hours: 2 }) });
 * ```
 *
 * Absent components are zero, so `expiryIn({})` is simply "now" — legal, and almost certainly not
 * what the caller meant, which is why it is not the default anywhere.
 *
 * @throws {LighterValidationError} `UNSAFE_INTEGER` if the components or the resulting timestamp are
 * not exact integers.
 */
export function expiryIn(
  d: { readonly days?: number; readonly hours?: number; readonly minutes?: number },
  now?: () => number,
): I64 {
  const offset: number =
    (d.days ?? 0) * MS_PER_DAY + (d.hours ?? 0) * MS_PER_HOUR + (d.minutes ?? 0) * MS_PER_MINUTE;
  if (!Number.isSafeInteger(offset)) {
    throw new LighterValidationError(
      "UNSAFE_INTEGER",
      `expiryIn: {days, hours, minutes} must describe a whole number of milliseconds, got ${String(offset)}`,
      { field: "ExpiredAt" },
    );
  }
  return i64(readClock(now) + offset);
}

/**
 * `OrderExpiry` for an immediate-or-cancel order: `0`, the nil sentinel.
 *
 * An IOC order that carries an expiry is rejected by `validateOrderTypeMatrix`, so this is the only
 * legal value there and naming it removes the temptation to write `Date.now()`.
 */
export const IOC_EXPIRY: I64 = i64(0);

/**
 * `ClientOrderIndex` for an order the caller does not want to name: `0`, the nil sentinel.
 *
 * Nil is not "unset" in the sense of being skipped — it is absorbed into the hash as zero like any
 * other value, and it means the order can only be cancelled by its sequencer-assigned index.
 */
export const NO_CLIENT_ORDER_INDEX: I64 = i64(0);

/**
 * A 32-byte transfer memo from hex, with or without a `0x` prefix.
 *
 * Exactly 64 hex digits. The memo is **not** in the L2 hash — it is bound to the transaction only
 * by the L1 signature (`spec/04-tx-types.md` §7.5) — so a wrong length is not caught by any hash
 * comparison and would otherwise surface as a rejected transfer.
 *
 * @throws {LighterValidationError} `MEMO_LENGTH_INVALID` for the wrong number of digits, or
 * whatever the shared hex decoder raises for a non-hex character.
 */
export function memoFromHex(hex: string): Uint8Array {
  const body: string = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (body.length !== MEMO_LENGTH * 2) {
    throw new LighterValidationError(
      "MEMO_LENGTH_INVALID",
      `memoFromHex: expected ${String(MEMO_LENGTH * 2)} hex digits (optionally 0x-prefixed), got ${String(body.length)}`,
      { field: "Memo", bound: MEMO_LENGTH },
    );
  }
  return hexToBytes(body);
}

/**
 * A 32-byte transfer memo from text: UTF-8 encoded, then zero-padded on the right.
 *
 * The limit is 32 **bytes**, not 32 characters — one emoji is four bytes and one accented letter is
 * two. Truncating silently would put a half-decoded code point into a field the user signed over,
 * so an over-long string is an error.
 *
 * @throws {LighterValidationError} `MEMO_LENGTH_INVALID` when the encoded form exceeds 32 bytes.
 */
export function memoFromUtf8(s: string): Uint8Array {
  const encoded: Uint8Array = utf8ToBytes(s);
  if (encoded.length > MEMO_LENGTH) {
    throw new LighterValidationError(
      "MEMO_LENGTH_INVALID",
      `memoFromUtf8: the memo must encode to at most ${String(MEMO_LENGTH)} UTF-8 bytes, got ${String(encoded.length)}`,
      { field: "Memo", bound: MEMO_LENGTH },
    );
  }
  const out: Uint8Array = new Uint8Array(MEMO_LENGTH);
  out.set(encoded, 0);
  return out;
}
