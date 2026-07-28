/**
 * Goldilocks field constants — pure data, zero imports, zero side effects.
 *
 * Everything cryptographic in this SDK stands on `p = 2^64 - 2^32 + 1`. The quintic extension
 * `GF(p^5)`, Poseidon2, the ECgFp5 curve, Schnorr signing and every transaction hash are built from
 * this one modulus, so a single wrong digit here is wrong for every input and traceable to nothing.
 *
 * Two constants are routinely "corrected" into the wrong value and neither can be re-derived:
 *
 * - {@link POWER_OF_TWO_GENERATOR} is `7277203076849721926`, **not** `7^((p-1)/2^32)`
 *   (`= 1753635133440165772`). It is inherited verbatim from plonky2 and it decides *which of the
 *   two* square roots Tonelli-Shanks returns. That choice propagates into `GF(p^5)` square roots,
 *   then into curve point decompression, then into public-key derivation. gnark seeds from
 *   `15733474329512464024` and returns the other root for some inputs; it is not a substitute.
 * - {@link FP5_DTH_ROOT} is `3^((p-1)/5)`, the fifth root of unity that drives Frobenius on
 *   `GF(p^5) = GF(p)[X]/(X^5 - 3)`.
 *
 * The `FP5_*` and `FROB*` constants live here rather than beside the `GF(p^5)` arithmetic that uses
 * them, because that module may not edit this file. They are exported with exactly these names.
 *
 * The four Frobenius tables satisfy `FROBk[i] === FP5_DTH_ROOT^(k*i) mod p`, which is the identity
 * the test file re-derives them from — a transcription slip cannot survive it.
 */

/** The Goldilocks prime, `2^64 - 2^32 + 1`. */
export const P: bigint = 18446744069414584321n;

/** `2^64 mod p = 2^32 - 1`. The fold factor in a hardware Goldilocks reduction. */
export const EPSILON: bigint = 4294967295n;

/** Low 32 bits set. */
export const MASK32: bigint = 0xffffffffn;

/** Low 64 bits set. */
export const MASK64: bigint = 0xffffffffffffffffn;

/** `p - 1` is divisible by `2^32` and no higher power of two. */
export const TWO_ADICITY: 32 = 32;

/**
 * Generator of the order-`2^32` subgroup, taken verbatim from plonky2.
 *
 * NOT `7^((p-1)/2^32)`, which is `1753635133440165772`. Substituting that value produces square
 * roots that are individually valid and collectively the wrong branch.
 */
export const POWER_OF_TWO_GENERATOR: bigint = 7277203076849721926n;

/** A generator of the full multiplicative group `GF(p)*`. */
export const MULTIPLICATIVE_GENERATOR: bigint = 7n;

/** `GF(p^5) = GF(p)[X]/(X^5 - W)` with `W = 3`. */
export const FP5_W: bigint = 3n;

/** `3^((p-1)/5) mod p` — a primitive fifth root of unity; the Frobenius multiplier. */
export const FP5_DTH_ROOT: bigint = 1041288259238279555n;

/** Frobenius `x -> x^p`: coefficient `i` is scaled by `FROB1[i] = FP5_DTH_ROOT^i`. */
export const FROB1: readonly bigint[] = Object.freeze([
  1n,
  1041288259238279555n,
  15820824984080659046n,
  211587555138949697n,
  1373043270956696022n,
]);

/** Frobenius squared, `x -> x^(p^2)`: `FROB2[i] = FROB1[i]^2 = FP5_DTH_ROOT^(2i)`. */
export const FROB2: readonly bigint[] = Object.freeze([
  1n,
  15820824984080659046n,
  1373043270956696022n,
  1041288259238279555n,
  211587555138949697n,
]);

/** Frobenius cubed, `x -> x^(p^3)`: `FROB3[i] = FP5_DTH_ROOT^(3i)`. */
export const FROB3: readonly bigint[] = Object.freeze([
  1n,
  211587555138949697n,
  1041288259238279555n,
  1373043270956696022n,
  15820824984080659046n,
]);

/** Frobenius to the fourth, `x -> x^(p^4)`: `FROB4[i] = FP5_DTH_ROOT^(4i)`. */
export const FROB4: readonly bigint[] = Object.freeze([
  1n,
  1373043270956696022n,
  211587555138949697n,
  15820824984080659046n,
  1041288259238279555n,
]);
