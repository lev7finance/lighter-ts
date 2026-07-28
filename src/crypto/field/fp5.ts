/**
 * Arithmetic in the quintic extension `GF(p^5) = GF(p)[X]/(X^5 - 3)`, `p = 2^64 - 2^32 + 1`.
 *
 * An element is the 5-tuple `(a0, a1, a2, a3, a4)` meaning `a0 + a1·X + a2·X^2 + a3·X^3 + a4·X^4`,
 * with `X^5 = 3`. This is the type the protocol actually moves around: a Schnorr public key is a
 * `GF(p^5)` element (40 bytes), a message hash is a `GF(p^5)` element (40 bytes), and Poseidon2's
 * `hashToQuinticExtension` produces one. The ECgFp5 curve is defined over this field.
 *
 * Four behaviours here have more than one mathematically defensible answer, and only one of them is
 * the wire answer. They are called out at their definition sites and repeated here because getting
 * any of them wrong yields public keys the exchange does not recognise, with no diagnostic:
 *
 * 1. {@link fp5Legendre} returns a **field element** — `0`, `1`, or `p - 1` — not a boolean or a
 *    signed integer. `x` is a square iff the result is in `{0, 1}`.
 * 2. {@link fp5Sqrt} of zero is `{ root: FP5_ZERO, exists: true }`. Zero *is* a square. A defensive
 *    `exists: false` guard on zero is wrong and is pinned wrong by `gfp5.json` case 0.
 * 3. {@link fp5Sgn0} is `true` when coefficient 0 is **EVEN**, inverted relative to RFC 9380 and the
 *    Rust ecgFp5 reference. The Go reference — which the exchange's verifier runs — tests `& 1 == 0`.
 * 4. {@link fp5CanonicalSqrt} therefore selects the root whose coefficient 0 is **odd**, and when
 *    both roots have coefficient 0 equal to zero it returns `neg(sqrt(x))` unconditionally. It is
 *    still deterministic, so interop is safe; it simply does not satisfy its name.
 *
 * The square root's branch also depends on `POWER_OF_TWO_GENERATOR` in `constants.ts`: it bottoms
 * out in `fpSqrt`, and a different 2^32-th root of unity there returns the other root here.
 *
 * Reduction is a single `%` per accumulated coefficient (`docs/decisions.md` D4). The Go reference's
 * `acc192` / `addProduct{,2,3,6}` scaffolding exists only because Go has no 128-bit integer type and
 * has no analogue under `BigInt`; hand-folding measured 2.5-4x *slower*.
 *
 * No Node built-ins, no dependencies: `BigInt`, `Uint8Array` and `DataView` only.
 */

import { LighterError, LighterMathError } from '../../errors.js';

import { FP5_DTH_ROOT, FP5_W, FROB1, FROB2, FROB3, FROB4, P } from './constants.js';
import {
  type Fp,
  FP_ZERO,
  fpExp,
  fpFromBytesUnchecked,
  fpFromInt,
  fpFromU64,
  fpInverseOrZero,
  fpSqrt,
  reduceWide,
} from './fp.js';

/**
 * An element of `GF(p^5)`: coefficient `i` is the coefficient of `X^i`, and every coefficient is a
 * canonical {@link Fp}.
 *
 * Always a fixed-length readonly tuple. It is never widened to `bigint[]` in a public signature —
 * the length is part of the contract, and `readonly` keeps callers from mutating a shared constant.
 */
export type Fp5 = readonly [Fp, Fp, Fp, Fp, Fp];

/** A Frobenius multiplier table: `t[i]` scales coefficient `i`. `t[0]` is always `1`. */
type FrobTable = readonly [bigint, bigint, bigint, bigint, bigint];

/** `X^5 = W = 3`, as a plain `bigint` for use inside unreduced accumulators. */
const W: bigint = FP5_W;

/** `2·W`, the coefficient of the merged cross terms in {@link fp5Square}. */
const W2: bigint = 2n * FP5_W;

/** `(p - 1) / 2` — Euler's criterion exponent, applied to the norm in {@link fp5Legendre}. */
const LEGENDRE_EXPONENT: bigint = (P - 1n) >> 1n;

/** Number of coefficients. Named so the byte-length arithmetic reads as `5 * 8`, not `40`. */
const DEGREE: number = 5;

/** Serialized width: five canonical little-endian `uint64`s. */
const FP5_BYTES: number = DEGREE * 8;

/**
 * Widen a constants-module table to a fixed-length tuple.
 *
 * `constants.ts` is owned by another unit and types its tables as `readonly bigint[]`, which under
 * `noUncheckedIndexedAccess` makes every element `bigint | undefined`. This narrows once, at module
 * load, rather than at each of the four use sites.
 */
function toTable(t: readonly bigint[], name: string): FrobTable {
  if (t.length !== DEGREE) {
    throw new LighterMathError(
      'NOT_REPRESENTABLE',
      `${name} must have ${DEGREE} entries, got ${t.length}`,
    );
  }
  const [c0 = 0n, c1 = 0n, c2 = 0n, c3 = 0n, c4 = 0n] = t;
  return [c0, c1, c2, c3, c4];
}

/** `zeta^0 = 1` for every coefficient: the identity, selected when `n % 5 === 0`. */
const FROB0: FrobTable = [1n, 1n, 1n, 1n, 1n];

/**
 * The five Frobenius tables indexed by `n mod 5`, hoisted once.
 *
 * `FROBk[i] = FP5_DTH_ROOT^(k·i) mod p`, because `X^p = X·(X^5)^((p-1)/5) = X·zeta`. The reference
 * recomputes `zeta^n` and a powers table on every call; these are constants.
 */
const FROB_TABLES: readonly [FrobTable, FrobTable, FrobTable, FrobTable, FrobTable] = [
  FROB0,
  toTable(FROB1, 'FROB1'),
  toTable(FROB2, 'FROB2'),
  toTable(FROB3, 'FROB3'),
  toTable(FROB4, 'FROB4'),
];

/** Additive identity, `0`. */
export const FP5_ZERO: Fp5 = Object.freeze<Fp5>([FP_ZERO, FP_ZERO, FP_ZERO, FP_ZERO, FP_ZERO]);

/** Multiplicative identity, `1`. */
export const FP5_ONE: Fp5 = Object.freeze<Fp5>([1n as Fp, FP_ZERO, FP_ZERO, FP_ZERO, FP_ZERO]);

/** The constant `2`. */
export const FP5_TWO: Fp5 = Object.freeze<Fp5>([2n as Fp, FP_ZERO, FP_ZERO, FP_ZERO, FP_ZERO]);

/** Re-exported so callers of this module do not have to reach into `constants.ts` for them. */
export { FP5_DTH_ROOT, FP5_W };

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------

/** Embed a base-field element: `c -> (c, 0, 0, 0, 0)`. */
export function fp5FromFp(c: Fp): Fp5 {
  return [c, FP_ZERO, FP_ZERO, FP_ZERO, FP_ZERO];
}

/**
 * Embed a 64-bit word, reduced into the base field.
 *
 * Domain is `[0, 2^64)`; anything outside throws, since it is a caller bug rather than a value to
 * silently wrap. Note the reduction: `fp5FromU64(2^64 - 1)` has coefficient 0 equal to `4294967294`.
 */
export function fp5FromU64(v: bigint): Fp5 {
  return fp5FromFp(fpFromU64(v));
}

/**
 * Build an element from exactly five integer coefficients, reduced Euclidean-style.
 *
 * The length is checked — a 4- or 6-element input is a framing mistake and never a value. The
 * coefficients themselves are reduced rather than rejected, of any sign and magnitude, so that
 * `fp5FromLimbs([-1n, ...])` gives `p - 1` rather than a negative "field element".
 */
export function fp5FromLimbs(l: readonly bigint[]): Fp5 {
  if (l.length !== DEGREE) {
    throw new LighterError('decode', `fp5FromLimbs: expected ${DEGREE} coefficients, got ${l.length}`);
  }
  const [c0 = 0n, c1 = 0n, c2 = 0n, c3 = 0n, c4 = 0n] = l;
  return [fpFromInt(c0), fpFromInt(c1), fpFromInt(c2), fpFromInt(c3), fpFromInt(c4)];
}

// ---------------------------------------------------------------------------------------------
// Linear operations — coefficient-wise
// ---------------------------------------------------------------------------------------------

/** `a + b`. */
export function fp5Add(a: Fp5, b: Fp5): Fp5 {
  const s0: bigint = a[0] + b[0];
  const s1: bigint = a[1] + b[1];
  const s2: bigint = a[2] + b[2];
  const s3: bigint = a[3] + b[3];
  const s4: bigint = a[4] + b[4];
  return [
    (s0 >= P ? s0 - P : s0) as Fp,
    (s1 >= P ? s1 - P : s1) as Fp,
    (s2 >= P ? s2 - P : s2) as Fp,
    (s3 >= P ? s3 - P : s3) as Fp,
    (s4 >= P ? s4 - P : s4) as Fp,
  ];
}

/** `a - b`. Each coefficient fixes up its own borrow — JavaScript `%` would follow the dividend. */
export function fp5Sub(a: Fp5, b: Fp5): Fp5 {
  const d0: bigint = a[0] - b[0];
  const d1: bigint = a[1] - b[1];
  const d2: bigint = a[2] - b[2];
  const d3: bigint = a[3] - b[3];
  const d4: bigint = a[4] - b[4];
  return [
    (d0 < 0n ? d0 + P : d0) as Fp,
    (d1 < 0n ? d1 + P : d1) as Fp,
    (d2 < 0n ? d2 + P : d2) as Fp,
    (d3 < 0n ? d3 + P : d3) as Fp,
    (d4 < 0n ? d4 + P : d4) as Fp,
  ];
}

/** `-a`. A zero coefficient negates to zero, not to `p`. */
export function fp5Neg(a: Fp5): Fp5 {
  return [
    (a[0] === 0n ? 0n : P - a[0]) as Fp,
    (a[1] === 0n ? 0n : P - a[1]) as Fp,
    (a[2] === 0n ? 0n : P - a[2]) as Fp,
    (a[3] === 0n ? 0n : P - a[3]) as Fp,
    (a[4] === 0n ? 0n : P - a[4]) as Fp,
  ];
}

/** `2a`. */
export function fp5Double(a: Fp5): Fp5 {
  return fp5Add(a, a);
}

/** `3a`. */
export function fp5Triple(a: Fp5): Fp5 {
  return [
    ((a[0] * 3n) % P) as Fp,
    ((a[1] * 3n) % P) as Fp,
    ((a[2] * 3n) % P) as Fp,
    ((a[3] * 3n) % P) as Fp,
    ((a[4] * 3n) % P) as Fp,
  ];
}

/** `c·a` for a base-field scalar `c` — not the same operation as {@link fp5Mul}. */
export function fp5ScalarMul(a: Fp5, c: Fp): Fp5 {
  return [
    ((a[0] * c) % P) as Fp,
    ((a[1] * c) % P) as Fp,
    ((a[2] * c) % P) as Fp,
    ((a[3] * c) % P) as Fp,
    ((a[4] * c) % P) as Fp,
  ];
}

// ---------------------------------------------------------------------------------------------
// Multiplication
// ---------------------------------------------------------------------------------------------

/**
 * `a·b`, schoolbook with the `X^5 = 3` fold applied once.
 *
 * Each coefficient accumulates as an **exact** `bigint` and is reduced exactly once. The largest
 * accumulator is `c0`, bounded by `13·(p-1)^2 < 2^132`, well inside {@link reduceWide}'s domain, so
 * a per-term `%` would be pure overhead. Five locals, one tuple, no intermediate arrays.
 */
export function fp5Mul(a: Fp5, b: Fp5): Fp5 {
  const a0: bigint = a[0];
  const a1: bigint = a[1];
  const a2: bigint = a[2];
  const a3: bigint = a[3];
  const a4: bigint = a[4];
  const b0: bigint = b[0];
  const b1: bigint = b[1];
  const b2: bigint = b[2];
  const b3: bigint = b[3];
  const b4: bigint = b[4];

  const c0: bigint = a0 * b0 + W * (a1 * b4 + a2 * b3 + a3 * b2 + a4 * b1);
  const c1: bigint = a0 * b1 + a1 * b0 + W * (a2 * b4 + a3 * b3 + a4 * b2);
  const c2: bigint = a0 * b2 + a1 * b1 + a2 * b0 + W * (a3 * b4 + a4 * b3);
  const c3: bigint = a0 * b3 + a1 * b2 + a2 * b1 + a3 * b0 + W * (a4 * b4);
  const c4: bigint = a0 * b4 + a1 * b3 + a2 * b2 + a3 * b1 + a4 * b0;

  return [reduceWide(c0), reduceWide(c1), reduceWide(c2), reduceWide(c3), reduceWide(c4)];
}

/**
 * `a^2` — the same fold with the cross terms merged: 15 base multiplications instead of 25.
 *
 * Kept as a distinct export rather than `fp5Mul(a, a)` because the square-root and curve paths call
 * it in tight loops (31 and 32 consecutive squarings inside {@link fp5Sqrt} alone).
 */
export function fp5Square(a: Fp5): Fp5 {
  const a0: bigint = a[0];
  const a1: bigint = a[1];
  const a2: bigint = a[2];
  const a3: bigint = a[3];
  const a4: bigint = a[4];

  const c0: bigint = a0 * a0 + W2 * (a1 * a4 + a2 * a3);
  const c1: bigint = 2n * a0 * a1 + W2 * (a2 * a4) + W * (a3 * a3);
  const c2: bigint = 2n * a0 * a2 + a1 * a1 + W2 * (a3 * a4);
  const c3: bigint = 2n * (a0 * a3 + a1 * a2) + W * (a4 * a4);
  const c4: bigint = 2n * (a0 * a4 + a1 * a3) + a2 * a2;

  return [reduceWide(c0), reduceWide(c1), reduceWide(c2), reduceWide(c3), reduceWide(c4)];
}

/** `a^(2^n)`, i.e. `n` repeated squarings. `n` must be a non-negative integer. */
export function fp5ExpPow2(a: Fp5, n: number): Fp5 {
  if (!Number.isInteger(n) || n < 0) {
    throw new LighterMathError('NOT_REPRESENTABLE', `fp5ExpPow2: invalid squaring count ${n}`);
  }
  let x: Fp5 = a;
  for (let i: number = 0; i < n; i += 1) x = fp5Square(x);
  return x;
}

// ---------------------------------------------------------------------------------------------
// Frobenius
// ---------------------------------------------------------------------------------------------

/** Apply a hoisted Frobenius table. Coefficient 0 is untouched, since every table starts with `1`. */
function applyFrob(a: Fp5, t: FrobTable): Fp5 {
  return [
    a[0],
    ((a[1] * t[1]) % P) as Fp,
    ((a[2] * t[2]) % P) as Fp,
    ((a[3] * t[3]) % P) as Fp,
    ((a[4] * t[4]) % P) as Fp,
  ];
}

/**
 * The Frobenius endomorphism `phi(x) = x^p`.
 *
 * `X^p = X·(X^5)^((p-1)/5) = X·zeta` with `zeta = FP5_DTH_ROOT`, so it is coefficient-wise scaling
 * by `zeta^i` — four base multiplications, no exponentiation.
 */
export function fp5Frobenius(a: Fp5): Fp5 {
  return applyFrob(a, FROB_TABLES[1]);
}

/**
 * `phi^n(x) = x^(p^n)` for `n >= 1`, selecting the table for `n mod 5` (the identity when
 * `n % 5 === 0`, since `phi^5` is the identity on `GF(p^5)`).
 *
 * **Non-positive `n` throws.** In the Go reference a negative count slips past the guards and the
 * loop simply does not execute, so `repeatedFrobenius(a, -1)` silently returns `a` — a Frobenius
 * that is quietly a no-op (`docs/protocol-notes.md` §11). Rejecting it keeps that latent bug from
 * being reproduced here.
 */
export function fp5RepeatedFrobenius(a: Fp5, n: number): Fp5 {
  if (!Number.isInteger(n) || n <= 0) {
    throw new LighterMathError(
      'NOT_REPRESENTABLE',
      `fp5RepeatedFrobenius: count must be a positive integer, got ${n}`,
    );
  }
  return applyFrob(a, FROB_TABLES[n % DEGREE] ?? FROB0);
}

// ---------------------------------------------------------------------------------------------
// Norm, inversion, Legendre
// ---------------------------------------------------------------------------------------------

/**
 * The norm and the cofactor it is built from, computed together.
 *
 * `f = a^(p + p^2 + p^3 + p^4)`, so `a·f = a^(1 + p + p^2 + p^3 + p^4) = N(a)` lies in `GF(p)` —
 * coefficients 1..4 of that product are provably zero, so only coefficient 0 is computed.
 *
 * Both {@link fp5InverseOrZero} and {@link fp5Legendre} need the pair. The reference computes the
 * norm inline in each, twice.
 */
function normAndCofactor(a: Fp5): { readonly n: Fp; readonly f: Fp5 } {
  const d: Fp5 = fp5Frobenius(a); //                            a^p
  const e: Fp5 = fp5Mul(d, fp5Frobenius(d)); //                 a^(p + p^2)
  const f: Fp5 = fp5Mul(e, applyFrob(e, FROB_TABLES[2])); //    a^(p + p^2 + p^3 + p^4)
  const n: Fp = reduceWide(
    a[0] * f[0] + W * (a[1] * f[4] + a[2] * f[3] + a[3] * f[2] + a[4] * f[1]),
  );
  return { n, f };
}

/** `N(a) = a·phi(a)·phi^2(a)·phi^3(a)·phi^4(a)`, an element of the base field. Zero only for zero. */
export function fp5Norm(a: Fp5): Fp {
  return normAndCofactor(a).n;
}

/**
 * Multiplicative inverse, with `0 -> 0`. Never throws.
 *
 * `a^-1 = f / N(a)` where `f` is the cofactor above. The total variant is what the extension-field
 * and square-root paths are written against: {@link fp5Sqrt} relies on `inverseOrZero(0) = 0` to
 * carry a zero input all the way through without a single branch.
 */
export function fp5InverseOrZero(a: Fp5): Fp5 {
  const { n, f } = normAndCofactor(a);
  return fp5ScalarMul(f, fpInverseOrZero(n));
}

/** Multiplicative inverse. Throws on zero, which has none. */
export function fp5Inverse(a: Fp5): Fp5 {
  if (fp5IsZero(a)) {
    throw new LighterMathError('NOT_REPRESENTABLE', 'fp5Inverse: zero has no multiplicative inverse');
  }
  return fp5InverseOrZero(a);
}

/** `a / b`. Throws when `b` is zero — the reference panics there, and so does this. */
export function fp5Div(a: Fp5, b: Fp5): Fp5 {
  if (fp5IsZero(b)) {
    throw new LighterMathError('NOT_REPRESENTABLE', 'fp5Div: division by zero');
  }
  return fp5Mul(a, fp5InverseOrZero(b));
}

/**
 * The Legendre symbol as a **base-field element**, not a boolean and not a signed integer:
 *
 * - `0` when `a` is zero,
 * - `1` when `a` is a non-zero square,
 * - `p - 1 = 18446744069414584320` when `a` is a non-square.
 *
 * `a` is a square iff the result is in `{0, 1}`. Returning a boolean would typecheck everywhere and
 * destroy the zero/non-zero distinction the curve layer depends on, so the three-valued field
 * element is the contract (`docs/protocol-notes.md` §11, `gfp5.json` -> `legendreA`).
 *
 * It is Euler's criterion pushed down to the base field: `(p^5-1)/2 = ((p-1)/2)·(1+p+p^2+p^3+p^4)`,
 * so `a^((p^5-1)/2) = N(a)^((p-1)/2)`.
 */
export function fp5Legendre(a: Fp5): Fp {
  const n: Fp = fp5Norm(a);
  if (n === 0n) return FP_ZERO;
  return fpExp(n, LEGENDRE_EXPONENT);
}

// ---------------------------------------------------------------------------------------------
// Square roots
// ---------------------------------------------------------------------------------------------

/**
 * Square root in `GF(p^5)`, or `{ root: FP5_ZERO, exists: false }` when `a` is not a square.
 *
 * The algorithm finds `e` with `a·e^2 ∈ GF(p)`, takes a base-field square root of that, and divides
 * back out. Written out step for step rather than replaced with an equivalent-looking variant,
 * because **which** of the two roots comes back is observable: it is decided by `fpSqrt`, hence by
 * `POWER_OF_TWO_GENERATOR`, and it propagates into curve point decompression and public keys.
 *
 * **`fp5Sqrt(FP5_ZERO)` is `{ root: FP5_ZERO, exists: true }`** — zero is a square, and `gfp5.json`
 * case 0 pins `sqrtAExists: true`. There is deliberately no zero guard: `fpInverseOrZero(0) = 0`
 * carries the zero through `v`, `d`, `e`, `f`, `g` and back out, and `fpSqrt(0) = 0`. Adding an
 * early `exists: false` return for zero looks defensive and is wrong.
 */
export function fp5Sqrt(a: Fp5): { root: Fp5; exists: boolean } {
  const v: Fp5 = fp5ExpPow2(a, 31); //                                       a^(2^31)
  const d: Fp5 = fp5Mul(fp5Mul(a, fp5ExpPow2(v, 32)), fp5InverseOrZero(v)); // a^(1 + 2^63 - 2^31)
  const e: Fp5 = fp5Frobenius(fp5Mul(d, applyFrob(d, FROB_TABLES[2]))); //   d^(p + p^3)
  const f: Fp5 = fp5Square(e);

  // g = (a·f)[0]; coefficients 1..4 of a·f are provably zero, so only this one is computed.
  const g: Fp = reduceWide(
    a[0] * f[0] + W * (a[1] * f[4] + a[2] * f[3] + a[3] * f[2] + a[4] * f[1]),
  );

  const s: Fp | null = fpSqrt(g);
  if (s === null) return { root: FP5_ZERO, exists: false };

  return { root: fp5Mul(fp5FromFp(s), fp5InverseOrZero(e)), exists: true };
}

/**
 * The sign convention: **`true` iff coefficient 0 is EVEN.**
 *
 * ⚠️ This is INVERTED relative to RFC 9380 and the Rust ecgFp5 reference, both of which are "first
 * non-zero limb is ODD". It is not a bug and it must not be "fixed". The Go reference tests
 * `limb & 1 == 0`, the exchange runs the Go verifier, and this feeds {@link fp5CanonicalSqrt} and
 * therefore curve point decompression — flipping it silently produces public keys the exchange does
 * not recognise, with no error anywhere in the stack (`docs/spec/01-crypto-field.md` §10.1).
 *
 * `fp5Sgn0(FP5_ZERO)` is `true`, pinned by `gfp5.json` case 0 (`sgn0A: true`).
 *
 * The reference writes this as a five-iteration "first non-zero limb" loop, which provably collapses
 * to this single test: at `i = 0` the empty prefix is all-zero, so the term is exactly "c0 even"; if
 * c0 is even the disjunction is already true, and if c0 is odd then c0 is non-zero and no later term
 * can fire.
 */
export function fp5Sgn0(a: Fp5): boolean {
  return (a[0] & 1n) === 0n;
}

/**
 * {@link fp5Sqrt} with a deterministic choice between the two roots: it returns the root whose
 * coefficient 0 is **odd**.
 *
 * The name overpromises, and that is preserved on purpose. When both roots have coefficient 0 equal
 * to zero, {@link fp5Sgn0} is `true` for both and this returns `neg(sqrt(a))` unconditionally — not
 * a lexicographically smallest or otherwise canonical root. It remains fully deterministic, because
 * {@link fp5Sqrt} is, so interop is safe; making it lexicographic would break it
 * (`docs/spec/01-crypto-field.md` §10.2).
 *
 * `fp5CanonicalSqrt(FP5_ZERO)` is `{ root: FP5_ZERO, exists: true }`.
 */
export function fp5CanonicalSqrt(a: Fp5): { root: Fp5; exists: boolean } {
  const { root, exists } = fp5Sqrt(a);
  if (!exists) return { root: FP5_ZERO, exists: false };
  return { root: fp5Sgn0(root) ? fp5Neg(root) : root, exists: true };
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

/** Coefficient-wise equality. Every {@link Fp5} is canonical, so this is plain `===`. */
export function fp5Equals(a: Fp5, b: Fp5): boolean {
  return (
    a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4]
  );
}

/** `a === 0`. */
export function fp5IsZero(a: Fp5): boolean {
  return a[0] === 0n && a[1] === 0n && a[2] === 0n && a[3] === 0n && a[4] === 0n;
}

// ---------------------------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------------------------

/**
 * Encode as 40 bytes: coefficient 0 first, each a canonical 8-byte little-endian `uint64`.
 *
 * This is exactly the encoding of a 40-byte Schnorr public key and of the 40-byte message hash fed
 * into signing. Encoders are always canonical (`docs/decisions.md` D3).
 */
export function fp5ToBytes(a: Fp5): Uint8Array {
  const out: Uint8Array = new Uint8Array(FP5_BYTES);
  const view: DataView = new DataView(out.buffer);
  for (let i: number = 0; i < DEGREE; i += 1) {
    view.setBigUint64(i * 8, a[i] ?? FP_ZERO, true);
  }
  return out;
}

/**
 * Decode 40 little-endian bytes, **reducing** any limb that is `>= p`.
 *
 * This is the interoperable default and the parser the sign/verify path and key import use
 * (`docs/decisions.md` D3). The reference's `Fp5.FromCanonicalLittleEndianBytes` checks length only
 * and performs no range validation at all, so the sequencer accepts non-canonical public keys,
 * message hashes and signatures. A strict parser here would reject signatures the exchange accepts —
 * that is an interop bug, not extra safety. {@link fp5FromBytesStrict} is the explicit opt-in for
 * user-facing decode APIs.
 *
 * The length check stays exact: a short or long buffer is a framing error, not a value.
 */
export function fp5FromBytes(b: Uint8Array): Fp5 {
  if (b.length !== FP5_BYTES) {
    throw new LighterError('decode', `fp5FromBytes: expected ${FP5_BYTES} bytes, got ${b.length}`);
  }
  return [
    fpFromBytesUnchecked(b.subarray(0, 8)),
    fpFromBytesUnchecked(b.subarray(8, 16)),
    fpFromBytesUnchecked(b.subarray(16, 24)),
    fpFromBytesUnchecked(b.subarray(24, 32)),
    fpFromBytesUnchecked(b.subarray(32, 40)),
  ];
}

/**
 * Decode 40 little-endian bytes, **rejecting** any limb `>= p`.
 *
 * The explicit opt-in. Use it where a caller is decoding user-supplied data and wants to hear about
 * a non-canonical encoding; never on the verify path, where the reference is permissive and matching
 * it is the whole point.
 */
export function fp5FromBytesStrict(b: Uint8Array): Fp5 {
  if (b.length !== FP5_BYTES) {
    throw new LighterError(
      'decode',
      `fp5FromBytesStrict: expected ${FP5_BYTES} bytes, got ${b.length}`,
    );
  }
  const view: DataView = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: bigint[] = new Array<bigint>(DEGREE).fill(0n);
  for (let i: number = 0; i < DEGREE; i += 1) {
    const v: bigint = view.getBigUint64(i * 8, true);
    if (v >= P) {
      throw new LighterError(
        'decode',
        `fp5FromBytesStrict: coefficient ${i} is ${v}, which is not a canonical field element`,
      );
    }
    out[i] = v;
  }
  const [c0 = 0n, c1 = 0n, c2 = 0n, c3 = 0n, c4 = 0n] = out;
  return [c0 as Fp, c1 as Fp, c2 as Fp, c3 as Fp, c4 as Fp];
}
