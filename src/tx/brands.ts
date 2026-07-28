/**
 * Branded integer widths and their smart constructors.
 *
 * A Lighter transaction is a struct of small integers, and almost every one of them is a bare
 * number in the protocol's own description: an account index, a market index, a price, a base
 * amount, a nonce, an expiry. Structurally they are interchangeable. Semantically they are not, and
 * the failure mode of confusing them is a transaction that hashes and signs cleanly and is rejected
 * by the sequencer, or worse, accepted with the wrong meaning.
 *
 * So each width gets a phantom brand. `U8` is `number` at runtime and *not* `number` at compile
 * time, and the only way to produce one is {@link u8}, which range-checks. Passing a `U32` where an
 * `I16` belongs is a type error; passing a raw `number` anywhere is a type error. The brand costs
 * nothing at runtime — it is erased entirely.
 *
 * ## Which width is which type
 *
 * The split is mechanical, from `spec/04-tx-types.md` §13.1: **every protocol field declared
 * `int64` or `uint64` is a `bigint`; every field 32 bits or narrower is a `number`.** There is no
 * per-field judgement call and no "it fits, so a number is fine" — `MaxOrderIndex` is `2^60 - 1`
 * and `MaxOrderExpiry` is `int64` max, and a `number` cannot hold either.
 *
 * {@link i64} and {@link u64} accept `bigint | number` because the public API does: a caller writing
 * `expiredAt: Date.now() + 60_000` has a `number`, and forcing `BigInt(...)` at every call site
 * buys nothing. The coercion happens **once**, here, and only after the value is proven to be a
 * safe integer — so `i64(2 ** 53)` throws rather than quietly becoming `9007199254740992n` when the
 * caller meant something they could not express. A `bigint` argument skips that check entirely,
 * which is why `i64(9007199254740993n)` is fine.
 *
 * ## What these constructors do not do
 *
 * They check **width**, and nothing else. Every domain rule — that an account index is at most
 * `2^48 - 2`, that a market index is in the perps or spot family, that `255` is an acceptable API
 * key index for `L2CancelAllOrders` and for nothing else — belongs to the per-transaction
 * validators. Baking any of that in here would make the sentinel rules invisible and unlocatable:
 * `u8()` cannot know which transaction it is being called for.
 *
 * Note in particular that `NilApiKeyIndex = 255`, `NilMarketIndex = 255` and `NilStrategyIndex = 8`
 * all sit *inside* their widths. No width check can distinguish them from ordinary values, and none
 * tries to.
 */

import { LighterValidationError } from "../errors.js";

/**
 * The phantom key. `unique symbol` guarantees no other module can produce a structurally
 * compatible object, and `declare` means it has no runtime existence at all.
 */
declare const brand: unique symbol;

/** `T` tagged with `K`. Assignable *to* `T`, never assignable *from* it. */
type Brand<T, K extends string> = T & { readonly [brand]: K };

/** An unsigned 8-bit integer, `[0, 255]`. API key indices, strategy indices, small mode codes. */
export type U8 = Brand<number, "u8">;

/** An unsigned 16-bit integer, `[0, 65535]`. Asset indices, share rates, margin fractions. */
export type U16 = Brand<number, "u16">;

/**
 * A signed 16-bit integer, `[-32768, 32767]`. Market indices.
 *
 * Market index is signed, and `-1` is reachable in decoded data, which is why it is not `U16`.
 */
export type I16 = Brand<number, "i16">;

/** An unsigned 32-bit integer, `[0, 4294967295]`. Prices, trigger prices, integrator fees. */
export type U32 = Brand<number, "u32">;

/** A signed 64-bit integer. Account indices, amounts, nonces, expiries. */
export type I64 = Brand<bigint, "i64">;

/** An unsigned 64-bit integer. Withdrawal amounts. */
export type U64 = Brand<bigint, "u64">;

/* ---- width bounds. Private: the protocol's domain bounds live in `constants.ts`. ------------- */

const U8_MIN: number = 0;
const U8_MAX: number = 255;
const U16_MIN: number = 0;
const U16_MAX: number = 65535;
const I16_MIN: number = -32768;
const I16_MAX: number = 32767;
const U32_MIN: number = 0;
const U32_MAX: number = 4294967295;

const I64_MIN: bigint = -9223372036854775808n;
const I64_MAX: bigint = 9223372036854775807n;
const U64_MIN: bigint = 0n;
const U64_MAX: bigint = 18446744073709551615n;

/**
 * Reject anything that is not an exactly-representable integer.
 *
 * Covers `NaN`, `±Infinity`, fractions, and — the one that matters — every magnitude past
 * `2^53 - 1`, where `number` has already lost the ability to distinguish adjacent integers. A value
 * that reaches this point and passes is exact, so the later range comparison is exact too.
 */
function assertSafeInteger(value: number, width: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new LighterValidationError(
      "UNSAFE_INTEGER",
      `${width}: ${String(value)} is not a safe integer; pass a bigint for values beyond 2^53 - 1`,
    );
  }
}

function assertInRange(value: number, min: number, max: number, width: string): void {
  if (value < min) {
    throw new LighterValidationError("VALUE_TOO_LOW", `${width}: ${String(value)} < ${String(min)}`, {
      bound: min,
    });
  }
  if (value > max) {
    throw new LighterValidationError("VALUE_TOO_HIGH", `${width}: ${String(value)} > ${String(max)}`, {
      bound: max,
    });
  }
}

function assertInRangeBig(value: bigint, min: bigint, max: bigint, width: string): void {
  if (value < min) {
    throw new LighterValidationError("VALUE_TOO_LOW", `${width}: ${value.toString()} < ${min.toString()}`, {
      bound: min,
    });
  }
  if (value > max) {
    throw new LighterValidationError("VALUE_TOO_HIGH", `${width}: ${value.toString()} > ${max.toString()}`, {
      bound: max,
    });
  }
}

/**
 * Widen to `bigint` exactly once, after proving the input carries the value the caller wrote.
 *
 * A `bigint` passes through untouched — it is already exact by construction, so there is nothing to
 * check and no reason to bound it by the safe-integer range.
 */
function toExactBigInt(value: bigint | number, width: string): bigint {
  if (typeof value === "bigint") return value;
  assertSafeInteger(value, width);
  return BigInt(value);
}

/**
 * Mint a {@link U8}. Range `[0, 255]`.
 *
 * Does **not** special-case `255`: it is `NilApiKeyIndex`, legal only for `L2CancelAllOrders`, and
 * that rule belongs to the validators.
 *
 * @throws {LighterValidationError} `UNSAFE_INTEGER`, `VALUE_TOO_LOW` or `VALUE_TOO_HIGH`.
 */
export function u8(v: number): U8 {
  assertSafeInteger(v, "u8");
  assertInRange(v, U8_MIN, U8_MAX, "u8");
  return v as U8;
}

/**
 * Mint a {@link U16}. Range `[0, 65535]`.
 *
 * @throws {LighterValidationError} `UNSAFE_INTEGER`, `VALUE_TOO_LOW` or `VALUE_TOO_HIGH`.
 */
export function u16(v: number): U16 {
  assertSafeInteger(v, "u16");
  assertInRange(v, U16_MIN, U16_MAX, "u16");
  return v as U16;
}

/**
 * Mint an {@link I16}. Range `[-32768, 32767]`.
 *
 * The signed width for market indices. Negative values are reachable, so this is not `u16`.
 *
 * @throws {LighterValidationError} `UNSAFE_INTEGER`, `VALUE_TOO_LOW` or `VALUE_TOO_HIGH`.
 */
export function i16(v: number): I16 {
  assertSafeInteger(v, "i16");
  assertInRange(v, I16_MIN, I16_MAX, "i16");
  return v as I16;
}

/**
 * Mint a {@link U32}. Range `[0, 4294967295]`.
 *
 * @throws {LighterValidationError} `UNSAFE_INTEGER`, `VALUE_TOO_LOW` or `VALUE_TOO_HIGH`.
 */
export function u32(v: number): U32 {
  assertSafeInteger(v, "u32");
  assertInRange(v, U32_MIN, U32_MAX, "u32");
  return v as U32;
}

/**
 * Mint an {@link I64}. Range `[-2^63, 2^63 - 1]`.
 *
 * `-1n` is inside the range and is a legal account index (`MinAccountIndex`), not an absence
 * marker. A `number` argument must be a safe integer; anything larger must be written as a
 * `bigint`, because by the time it arrives as a `number` the exact value is already gone.
 *
 * @throws {LighterValidationError} `UNSAFE_INTEGER`, `VALUE_TOO_LOW` or `VALUE_TOO_HIGH`.
 */
export function i64(v: bigint | number): I64 {
  const wide: bigint = toExactBigInt(v, "i64");
  assertInRangeBig(wide, I64_MIN, I64_MAX, "i64");
  return wide as I64;
}

/**
 * Mint a {@link U64}. Range `[0, 2^64 - 1]`.
 *
 * @throws {LighterValidationError} `UNSAFE_INTEGER`, `VALUE_TOO_LOW` or `VALUE_TOO_HIGH`.
 */
export function u64(v: bigint | number): U64 {
  const wide: bigint = toExactBigInt(v, "u64");
  assertInRangeBig(wide, U64_MIN, U64_MAX, "u64");
  return wide as U64;
}
