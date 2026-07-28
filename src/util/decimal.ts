/**
 * Exact decimal arithmetic.
 *
 * The Lighter API returns every monetary and size value as a decimal **string** at the market's
 * declared precision (`supported_size_decimals`, `supported_price_decimals`,
 * `supported_quote_decimals`). This module converts between those strings and scaled `bigint`s
 * without ever passing through a binary floating-point value.
 *
 * That restriction is not fastidiousness. `docs/protocol-notes.md` §9 records four defects found by
 * executing the Python reference, and each one is a specific thing this file refuses to do:
 *
 * 1. **Its rounding is not JavaScript's rounding.** Python's `round()` is round-half-to-even; the
 *    JavaScript built-in is half-up. `round(2500.5)` is `2500` there and `2501` here. They agree on
 *    odd halves and disagree on even ones, so a bad translation passes casual testing and loses
 *    money on half the ticks. `HALF_EVEN` below is half-to-even implemented over integers.
 * 2. **`int(quote_amount * 1e6)` loses money.** `8.2 * 1e6` is `8199999.999999999` in binary64 and
 *    truncates to `8199999`: a user who asked to spend 8.2 USDC gets an order for 8.199999. Here
 *    `toScaled("8.2", 6, "EXACT")` is `8200000n`, exactly, and a test pins it.
 * 3. **`int(price.replace(".", ""))` is right only by accident.** It happens to work while the API
 *    pads to the market's declared decimals and is off by 100× the moment it does not — `"2500.1"`
 *    at two decimals becomes `25001` instead of `250010`. Nothing here strips a decimal point;
 *    everything shifts by `10^(d − exponent)`.
 * 4. **Return types that diverge by branch.** The reference returns an exact rational on one path
 *    and a lossy float on another. Every function here returns `bigint` or `string`.
 *
 * **`mode` is required wherever a value can be lost.** There is no default, because the direction
 * is a per-call-site decision: `docs/decisions.md` D7 and
 * `spec/07-high-level-client.md` §3.2 tabulate buy `FLOOR` / sell `CEIL` to tighten rather than
 * loosen the slippage cap. Applying that policy is the order-math unit's job, and a default here
 * would silently pick a side on its behalf. For the same reason there are no
 * `CONSERVATIVE` / `AGGRESSIVE` aliases in this module: those are policy, and policy lives with the
 * order math.
 *
 * No I/O, no timers, no globals mutated.
 */

import { LighterMathError, LighterValidationError } from "../errors.js";

/**
 * What to do when a conversion cannot be represented exactly.
 *
 * - `EXACT` — throw {@link LighterMathError} with `code: "NOT_REPRESENTABLE"`.
 * - `FLOOR` — toward −∞ (**not** toward zero; the two differ for every negative value).
 * - `CEIL` — toward +∞.
 * - `HALF_EVEN` — to nearest, ties to an even quotient. Python's `round()`, over integers.
 */
export type RoundingMode = "EXACT" | "FLOOR" | "CEIL" | "HALF_EVEN";

/** A decimal string decomposed exactly: `value = unscaled × 10^-scale`. */
export interface ParsedDecimal {
  readonly unscaled: bigint;
  readonly scale: number;
}

/** Largest `decimals` argument accepted anywhere in this module. */
const MAX_DECIMALS: 36 = 36;

/**
 * Optional `-`, one or more digits, and at most one fractional part with at least one digit.
 *
 * Everything else is rejected on purpose: exponent notation (`1e6`), `NaN`, `Infinity`, `+1`,
 * `.5`, `5.`, `1.2.3`, surrounding whitespace, an empty string. None of them appear on the wire,
 * and accepting any of them means some caller upstream produced this string with a float parser.
 */
const DECIMAL_PATTERN: RegExp = /^-?[0-9]+(?:\.[0-9]+)?$/;

/**
 * Decompose a decimal string exactly. Lexical: splits on `.` and never consults any numeric parser.
 *
 * `"2500.1"` → `{ unscaled: 25001n, scale: 1 }`, `"-0.001"` → `{ unscaled: -1n, scale: 3 }`,
 * `"-0"` → `{ unscaled: 0n, scale: 0 }`.
 */
export function parseDecimal(s: string): ParsedDecimal {
  if (typeof s !== "string" || !DECIMAL_PATTERN.test(s)) {
    throw new LighterValidationError(
      "INVALID_DECIMAL",
      `not a plain decimal string: ${describeDecimal(s)}`,
    );
  }
  const dot: number = s.indexOf(".");
  if (dot < 0) return { unscaled: BigInt(s), scale: 0 };
  const digits: string = s.slice(0, dot) + s.slice(dot + 1);
  return { unscaled: BigInt(digits), scale: s.length - dot - 1 };
}

/**
 * Decimal string → `bigint` scaled by `10^decimals`.
 *
 * Exact whenever `decimals` is at least the string's own exponent; otherwise the surplus digits are
 * removed under `mode`, and `EXACT` refuses.
 */
export function toScaled(s: string, decimals: number, mode: RoundingMode): bigint {
  assertDecimals(decimals);
  const parsed: ParsedDecimal = parseDecimal(s);
  return shift(parsed.unscaled, decimals - parsed.scale, mode);
}

/**
 * `bigint` scaled by `10^decimals` → decimal string.
 *
 * Emits exactly `decimals` fraction digits with no trailing-zero trimming — `fromScaled(0n, 6)` is
 * `"0.000000"`, because the scale is information the caller may need to keep. A `-` appears only
 * for genuinely negative values, so `"-0.000000"` is unreachable.
 */
export function fromScaled(v: bigint, decimals: number): string {
  assertDecimals(decimals);
  const negative: boolean = v < 0n;
  const magnitude: string = (negative ? -v : v).toString();
  if (decimals === 0) return (negative ? "-" : "") + magnitude;
  const padded: string = magnitude.padStart(decimals + 1, "0");
  const split: number = padded.length - decimals;
  return (negative ? "-" : "") + padded.slice(0, split) + "." + padded.slice(split);
}

/** Move a scaled `bigint` between scales. Exact when widening; rounded under `mode` when narrowing. */
export function rescale(
  v: bigint,
  fromDecimals: number,
  toDecimals: number,
  mode: RoundingMode,
): bigint {
  assertDecimals(fromDecimals);
  assertDecimals(toDecimals);
  return shift(v, toDecimals - fromDecimals, mode);
}

/**
 * Re-express a decimal string at exactly `decimals` fraction digits.
 *
 * The canonical form for comparing against a server value, which is padded to the market's declared
 * precision: `normalizeDecimal("2500.1", 2, "EXACT")` is `"2500.10"`.
 */
export function normalizeDecimal(s: string, decimals: number, mode: RoundingMode): string {
  return fromScaled(toScaled(s, decimals, mode), decimals);
}

/**
 * Exact three-way comparison of two decimal strings, by aligning scales in `bigint`.
 *
 * The order book needs this. The reference WebSocket client tests sizes with `float()`, which is
 * the same money-through-float hazard as everything else in §9 — and here it decides whether a
 * price level is removed from the book.
 */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const left: ParsedDecimal = parseDecimal(a);
  const right: ParsedDecimal = parseDecimal(b);
  const scale: number = left.scale > right.scale ? left.scale : right.scale;
  const lifted: bigint = left.unscaled * pow10(scale - left.scale);
  const other: bigint = right.unscaled * pow10(scale - right.scale);
  if (lifted < other) return -1;
  if (lifted > other) return 1;
  return 0;
}

/**
 * The rounding primitive every other function here is built on.
 *
 * Correct for negative numerators, which is the whole reason it exists: `bigint` division truncates
 * toward zero and `%` takes the sign of the dividend, so `-7n / 2n` is `-3n` and `-7n % 2n` is
 * `-1n`. Writing `FLOOR` as plain `/` is therefore wrong for every negative value, and negatives
 * are reachable — `L2UpdateMargin.USDCAmount` accepts `-1`, and PnL and funding are signed.
 *
 * Ties under `HALF_EVEN` are decided on the parity of the **quotient**, not of the numerator, and
 * the result is symmetric about zero: `5/2 → 2`, `-5/2 → -2`, `7/2 → 4`, `-7/2 → -4`.
 */
export function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new LighterValidationError("DIVISION_BY_ZERO", "cannot divide by zero");
  }
  // Normalise the sign onto the numerator so the remainder's sign is the result's sign.
  const n: bigint = denominator < 0n ? -numerator : numerator;
  const d: bigint = denominator < 0n ? -denominator : denominator;

  const quotient: bigint = n / d; // truncated toward zero
  const remainder: bigint = n % d; // sign follows `n`
  if (remainder === 0n) return quotient;

  switch (mode) {
    case "EXACT":
      throw new LighterMathError(
        "NOT_REPRESENTABLE",
        `${numerator.toString()} / ${denominator.toString()} is not an exact integer`,
      );
    case "FLOOR":
      return remainder < 0n ? quotient - 1n : quotient;
    case "CEIL":
      return remainder > 0n ? quotient + 1n : quotient;
    case "HALF_EVEN": {
      const away: bigint = remainder < 0n ? quotient - 1n : quotient + 1n;
      const twice: bigint = remainder < 0n ? -remainder * 2n : remainder * 2n;
      if (twice > d) return away;
      if (twice < d) return quotient;
      // Exact tie: keep whichever candidate is even. `quotient` and `away` differ by one, so
      // exactly one of them is.
      return (quotient & 1n) === 0n ? quotient : away;
    }
    default:
      throw new LighterValidationError(
        "INVALID_ROUNDING_MODE",
        `unknown rounding mode: ${String(mode)}`,
      );
  }
}

/** `v × 10^places`, dividing under `mode` when `places` is negative. */
function shift(v: bigint, places: number, mode: RoundingMode): bigint {
  if (places >= 0) return v * pow10(places);
  return divRound(v, pow10(-places), mode);
}

/** `10^n` for a non-negative `n`. */
function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * `decimals` must be an integer in `[0, 36]`.
 *
 * `Number.isInteger` is a shape check on an argument, not arithmetic on a monetary value — it is
 * the one permitted use of the numeric namespace in this file.
 */
function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new LighterValidationError(
      "INVALID_DECIMALS",
      `decimals must be an integer in [0, ${MAX_DECIMALS}], got ${String(decimals)}`,
      { bound: MAX_DECIMALS },
    );
  }
}

/** A short, bounded rendering of a rejected input for an error message. */
function describeDecimal(s: unknown): string {
  if (typeof s !== "string") return `a value of type ${typeof s}`;
  const shown: string = s.length > 32 ? s.slice(0, 32) + "…" : s;
  return JSON.stringify(shown);
}
