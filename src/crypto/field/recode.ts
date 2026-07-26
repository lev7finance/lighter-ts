/**
 * Signed windowed digit recoding — the representation scalar multiplication consumes.
 *
 * A scalar multiply walks the scalar in fixed-width windows and adds a precomputed multiple of the
 * base point per window. Using *signed* digits halves the table: a window value above the midpoint
 * is expressed as a negative digit plus a carry into the next window, so only `[1, 2^(w-1)]` needs
 * to be precomputed and negatives are served by point negation, which is free on this curve.
 *
 * The whole module is two functions over one `bigint`. The reference carries an `acc`/`accLen`/`j`/
 * `cc` limb accumulator that shuffles 64-bit words into 5-bit windows; under `BigInt` that state
 * machine produces identical digits and is pure noise, so it is deliberately not reproduced.
 *
 * Three properties are load-bearing.
 *
 * **1. The digit range is asymmetric.** For `w = 5` it is `[-15, +16]`, and `+16` is reachable — a
 * window sized for `[-16, +15]` overflows on the top digit. The carry rule is stated in terms of a
 * strict `>`:
 *
 * ```text
 * chunk in [0, 31],  v = chunk + carry in [0, 32]
 * v > 16  ->  digit = v - 32, carry = 1     // digit in [-15, 0]
 * else    ->  digit = v,      carry = 0     // digit in [0, 16]
 * ```
 *
 * **2. Truncation is an error, not a rounding.** The recoding is exact —
 * `sum(d_i * 2^(w*i)) === m` — only when the final carry is absorbed by the requested digit count.
 * If it is not, the digits describe a *different* integer, and a scalar multiplication over them
 * yields a valid-looking point for the wrong scalar. That is the failure mode behind recoding a
 * 319-bit scalar into 33 digits: `sk = 1, 2, 3` still give the right answer and every real key does
 * not. So the overflow case throws rather than returning short digits.
 *
 * **3. `recodeSigned5` is not the scalar path.** It is the reference's `int.RecodeSigned5` over a
 * 161-bit *signed* domain — 33 digits, used only by the GLV-style split of the optional Weierstrass
 * representation. The signing path recodes a full scalar into `ceil(320 / 5) = 64` digits and lives
 * in `src/crypto/scalar.ts`. The offset-and-fixup below belongs to the 161-bit variant alone.
 *
 * Digits are the only `number` values in this module; every intermediate is a `bigint`.
 */

import { LighterMathError } from "../../errors.js";

/** Half the 161-bit signed domain: `2^160`, which is also `32^32`. */
const OFFSET_161: bigint = 1n << 160n;

/** Digit count of {@link recodeSigned5}: `ceil(161 / 5) = 33`. */
const SIGNED_161_DIGITS: 33 = 33;

/** Window width of {@link recodeSigned5}. */
const WINDOW_5: 5 = 5;

/**
 * Recode a non-negative integer into `count` signed digits of width `w`.
 *
 * The digits satisfy `sum(digits[i] * 2^(w*i)) === m` exactly, with each digit in
 * `[-(2^(w-1) - 1), 2^(w-1)]`. The top digit is non-negative whenever the input leaves at least one
 * bit of headroom in `count` windows, which is the case for every caller here.
 *
 * Throws when `m` is negative — the caller must map its signed domain onto a non-negative one
 * first, as {@link recodeSigned5} does — and when `m` does not fit in `count` windows, because
 * silently truncated digits denote a different scalar.
 */
export function recodeSignedDigits(m: bigint, count: number, w: number): Int32Array {
  if (!Number.isInteger(count) || count < 0) {
    throw new LighterMathError("NOT_REPRESENTABLE", `recodeSignedDigits: invalid digit count ${count}`);
  }
  if (!Number.isInteger(w) || w < 2 || w > 31) {
    throw new LighterMathError("NOT_REPRESENTABLE", `recodeSignedDigits: window width ${w} is outside [2, 31]`);
  }
  if (m < 0n) {
    throw new LighterMathError("NOT_REPRESENTABLE", `recodeSignedDigits: ${m} is negative`);
  }

  const width: bigint = BigInt(w);
  const mask: bigint = (1n << width) - 1n; //          2^w - 1
  const half: bigint = 1n << (width - 1n); //          2^(w-1), the inclusive upper digit bound
  const full: bigint = 1n << width; //                 2^w, subtracted to make a digit negative

  const out: Int32Array = new Int32Array(count);
  let rest: bigint = m;
  let carry: bigint = 0n;

  for (let i: number = 0; i < count; i += 1) {
    const v: bigint = (rest & mask) + carry;
    rest >>= width;
    if (v > half) {
      out[i] = Number(v - full);
      carry = 1n;
    } else {
      out[i] = Number(v);
      carry = 0n;
    }
  }

  if (rest !== 0n || carry !== 0n) {
    throw new LighterMathError(
      "NOT_REPRESENTABLE",
      `recodeSignedDigits: ${m} does not fit in ${count} digits of width ${w}`,
    );
  }
  return out;
}

/**
 * The reference's `int.RecodeSigned5(Signed161)`: 33 signed width-5 digits over the signed domain
 * `[-2^160, 2^160)`, satisfying `sum(digits[i] * 32^i) === v`.
 *
 * The signed input is shifted into `[0, 2^161)`, recoded, and the offset removed again by
 * subtracting one from digit 32 — `32^32` is exactly `2^160`. The result of that fixup is in
 * `[-1, 1]`, well inside the digit range.
 *
 * This is **not** the function that recodes a signing scalar. 33 digits cover 165 bits, and a
 * 319-bit scalar recoded here would be silently wrong for every real private key. See
 * `recodeScalar5` in `src/crypto/scalar.ts`.
 */
export function recodeSigned5(n: bigint): Int32Array {
  if (n < -OFFSET_161 || n >= OFFSET_161) {
    throw new LighterMathError("NOT_REPRESENTABLE", `recodeSigned5: ${n} is outside [-2^160, 2^160)`);
  }
  const digits: Int32Array = recodeSignedDigits(n + OFFSET_161, SIGNED_161_DIGITS, WINDOW_5);
  const top: number = SIGNED_161_DIGITS - 1;
  digits[top] = (digits[top] ?? 0) - 1;
  return digits;
}
