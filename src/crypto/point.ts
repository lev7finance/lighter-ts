/**
 * The ECgFp5 group: point representation, group law, and the 40-byte codec.
 *
 * The curve is `E : y^2 = x·(x^2 + a·x + b)` over `GF(p^5)` with `a = 2` and `b = 263·X`. It is a
 * *double-odd* curve: `|E| = 2n` with `n` prime, and `E` has exactly one point of order two,
 * `N = (0, 0)`.
 *
 * Four things about this file are load-bearing and are the difference between "passes every vector"
 * and "passes none of them".
 *
 * **1. The protocol group is not a subgroup of `E` under ordinary addition.** It is the coset
 * `N + E[n]` — precisely the half of `E` that decoding produces — under the *shifted* law
 * `P (+) Q = P + Q + N`, whose neutral element is `N` itself.
 * `(G, (+))` is cyclic of prime order `n`, so the **cofactor is 1**: there is no subgroup check to
 * perform, ever, and any successfully decoded point is a valid group element. The complete addition
 * formulas below already build the `+ N` in — {@link pointAdd} is the shifted law, and callers never
 * add `N` explicitly. Relative to ordinary curve arithmetic `[k]P = kP + (k-1)N`; that identity is
 * how to reconcile this code with external ecgfp5 material, and it is *not* what this code computes.
 *
 * **2. {@link encodePoint} is `T / U`, i.e. `1/u = y/x` — not `U / T`.** Inverting it makes
 * `encode(G)` come out as the inverse of `4` instead of `4`, and every layer above fails with no
 * localisation. `encodePoint(GENERATOR)` being `[4, 0, 0, 0, 0]` is the cheapest falsification test
 * in the whole crypto stack.
 *
 * **3. {@link decodePoint} keeps the NON-square root.** The two roots of `x^2 - (w^2 - a)x + b = 0`
 * multiply to `b`, and `b` is a non-square in `GF(p^5)`, so exactly one root is a square — discard
 * it. Picking the square root instead yields `P + N` under *ordinary* curve addition: a real curve
 * point, with the same `u`, which round-trips through {@link pointIsOnCurve} and is nonetheless
 * outside the group. Because the selection is phrased in terms of
 * squareness rather than sign, the decoded point does not depend on `fp5Sqrt`'s root convention.
 *
 * **4. `w = 0` turns a square-root failure into a success.** `a^2 - 4b` is a non-square, so the
 * sqrt of `delta` fails for `w = 0`; `success = ok || (w == 0)` and `w == 0` decodes to the neutral.
 * Rejecting the neutral *public key* is the signer's job (`docs/decisions.md` D1), not the codec's,
 * and `curve.json -> neutralEncoded` pins the round trip.
 *
 * Deliberately absent, per `docs/spec/03-crypto-curve-schnorr.md` §3.2 and §3.6: the reference's
 * specialised n-fold doubling (`mDouble`), which is a ~30%-of-one-scalar-multiplication optimisation
 * with three distinct code paths and the most likely source of a subtle bug in this layer; and the
 * short Weierstrass representation, which is zk-circuit interop only and unused by sign or verify.
 *
 * No Node built-ins, no dependencies: `BigInt` and the `GF(p^5)` layer only.
 */

import { P } from './field/constants.js';
import { type Fp, fpFromU64 } from './field/fp.js';
import {
  type Fp5,
  FP5_ONE,
  FP5_ZERO,
  fp5Add,
  fp5Double,
  fp5Equals,
  fp5FromLimbs,
  fp5InverseOrZero,
  fp5IsZero,
  fp5Legendre,
  fp5Mul,
  fp5Neg,
  fp5ScalarMul,
  fp5Sqrt,
  fp5Square,
  fp5Sub,
} from './field/fp5.js';

// ---------------------------------------------------------------------------------------------
// Representations
// ---------------------------------------------------------------------------------------------

/**
 * A group element in fractional coordinates: `x = X/Z` and `u = U/T`, where `u = x/y`.
 *
 * This is the working representation for all arithmetic. The neutral is exactly `U = 0` (with any
 * `T != 0`); its canonical form is `(X:Z, U:T) = (0:1, 0:1)`.
 */
export interface CurvePoint {
  readonly X: Fp5;
  readonly Z: Fp5;
  readonly U: Fp5;
  readonly T: Fp5;
}

/**
 * A group element in `(x, u)` affine coordinates, with `u = x/y`. `u = 0` denotes the neutral.
 *
 * Used by window tables and by {@link pointAddAffine}, whose right operand is affine.
 */
export interface AffinePoint {
  readonly x: Fp5;
  readonly u: Fp5;
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** `X^5 = 3` in `GF(p^5) = GF(p)[X]/(X^5 - 3)`, needed by the `c·X` fast paths below. */
const W: bigint = 3n;

/** The curve's `a` coefficient: `2`. */
export const CURVE_A: Fp5 = Object.freeze(fp5FromLimbs([2n, 0n, 0n, 0n, 0n]));

/** The curve's `b` coefficient: `263·X`. A **non-square**, which is what makes decoding canonical. */
export const CURVE_B: Fp5 = Object.freeze(fp5FromLimbs([0n, 263n, 0n, 0n, 0n]));

/** `4b = 1052·X`, the discriminant term in {@link decodePoint}. `a^2 - 4b` is a non-square. */
const CURVE_4B: Fp5 = Object.freeze(fp5FromLimbs([0n, 1052n, 0n, 0n, 0n]));

/** `263`, `2·263` and `4·263` — the `X`-coefficients of `b`, `2b` and `4b`. */
const B1: bigint = 263n;
const B1_X2: bigint = 526n;
const B1_X4: bigint = 1052n;

/** `1/2` in the base field, i.e. `(p + 1)/2`. Used to halve `e ± r` when decoding. */
const INV_TWO: Fp = fpFromU64((P + 1n) / 2n);

/**
 * The neutral element `N = (0, 0)`, in canonical fractional form `(0:1, 0:1)`.
 *
 * `encodePoint(NEUTRAL)` is zero, pinned by `curve.json -> neutralEncoded`.
 */
export const NEUTRAL: CurvePoint = Object.freeze({
  X: FP5_ZERO,
  Z: FP5_ONE,
  U: FP5_ZERO,
  T: FP5_ONE,
});

/**
 * The conventional generator of `(G, (+))`, `docs/spec/03-crypto-curve-schnorr.md` §3.4.
 *
 * `y = 4x`, hence `u = x/y = 1/4` and the fractional form `(x : 1, 1 : 4)`.
 * `encodePoint(GENERATOR)` is `[4, 0, 0, 0, 0]`, pinned by `curve.json -> generatorEncoded`.
 */
export const GENERATOR: CurvePoint = Object.freeze({
  X: fp5FromLimbs([
    12883135586176881569n,
    4356519642755055268n,
    5248930565894896907n,
    2165973894480315022n,
    2448410071095648785n,
  ]),
  Z: FP5_ONE,
  U: FP5_ONE,
  T: fp5FromLimbs([4n, 0n, 0n, 0n, 0n]),
});

// ---------------------------------------------------------------------------------------------
// Multiplication by a small multiple of X
// ---------------------------------------------------------------------------------------------

/**
 * `(c·X)·a` for a small base-field constant `c`, in 5 base-field multiplications instead of 25.
 *
 * `b`, `2b` and `4b` are all of the form `c·X`, and they appear in every addition and doubling. The
 * fold is the defining relation `X^5 = 3`, so the top coefficient wraps into position 0 scaled by
 * `3·c`:
 *
 * ```
 * (c·X)·(a0 + a1·X + a2·X^2 + a3·X^3 + a4·X^4)
 *   = 3·c·a4 + c·a0·X + c·a1·X^2 + c·a2·X^3 + c·a3·X^4
 * ```
 *
 * `c <= 1052` and each coefficient is below `p < 2^64`, so every product is well under `2^75` and a
 * single `%` is exact. The equivalence to `fp5Mul(fp5FromLimbs([0, c, 0, 0, 0]), a)` is asserted by
 * a property test rather than left as a comment.
 */
function mulSmallX(a: Fp5, c: bigint): Fp5 {
  const cw: bigint = c * W;
  return [
    ((a[4] * cw) % P) as Fp,
    ((a[0] * c) % P) as Fp,
    ((a[1] * c) % P) as Fp,
    ((a[2] * c) % P) as Fp,
    ((a[3] * c) % P) as Fp,
  ];
}

// ---------------------------------------------------------------------------------------------
// Group law
// ---------------------------------------------------------------------------------------------

/**
 * The group law `P (+) Q = P + Q + N`, complete: 10 multiplications, no exceptional cases.
 *
 * Works when either operand is the neutral and when `p === q`. There is no `+ N` for the caller to
 * add — it is already in these formulas. `docs/spec/03-crypto-curve-schnorr.md` §3.6.
 */
export function pointAdd(p: CurvePoint, q: CurvePoint): CurvePoint {
  const t1: Fp5 = fp5Mul(p.X, q.X);
  const t2: Fp5 = fp5Mul(p.Z, q.Z);
  const t3: Fp5 = fp5Mul(p.U, q.U);
  const t4: Fp5 = fp5Mul(p.T, q.T);

  //  X1·Z2 + X2·Z1, via one multiplication instead of two.
  const t5: Fp5 = fp5Sub(fp5Sub(fp5Mul(fp5Add(p.X, p.Z), fp5Add(q.X, q.Z)), t1), t2);
  //  U1·T2 + U2·T1, likewise.
  const t6: Fp5 = fp5Sub(fp5Sub(fp5Mul(fp5Add(p.U, p.T), fp5Add(q.U, q.T)), t3), t4);

  const t7: Fp5 = fp5Add(t1, mulSmallX(t2, B1)); //                     t1 + b·t2
  const t8: Fp5 = fp5Mul(t4, t7);
  const t9: Fp5 = fp5Mul(t3, fp5Add(mulSmallX(t5, B1_X2), fp5Double(t7)));
  const t10: Fp5 = fp5Mul(fp5Add(t4, fp5Double(t3)), fp5Add(t5, t7));

  return {
    X: mulSmallX(fp5Sub(t10, t8), B1),
    Z: fp5Sub(t8, t9),
    U: fp5Mul(t6, fp5Sub(mulSmallX(t2, B1), t1)),
    T: fp5Add(t8, t9),
  };
}

/**
 * The same law with an affine right operand (`Z2 = T2 = 1`): 8 multiplications.
 *
 * Also complete — adding the affine neutral `(0, 0)` leaves `(X:Z, U:T)` unchanged up to a common
 * factor, and a neutral left operand is handled too.
 */
export function pointAddAffine(p: CurvePoint, q: AffinePoint): CurvePoint {
  const t1: Fp5 = fp5Mul(p.X, q.x);
  const t2: Fp5 = p.Z; //                                              Z1·1
  const t3: Fp5 = fp5Mul(p.U, q.u);
  const t4: Fp5 = p.T; //                                              T1·1

  const t5: Fp5 = fp5Add(p.X, fp5Mul(q.x, p.Z)); //                    X1·1 + x2·Z1
  const t6: Fp5 = fp5Add(p.U, fp5Mul(q.u, p.T)); //                    U1·1 + u2·T1

  const t7: Fp5 = fp5Add(t1, mulSmallX(t2, B1));
  const t8: Fp5 = fp5Mul(t4, t7);
  const t9: Fp5 = fp5Mul(t3, fp5Add(mulSmallX(t5, B1_X2), fp5Double(t7)));
  const t10: Fp5 = fp5Mul(fp5Add(t4, fp5Double(t3)), fp5Add(t5, t7));

  return {
    X: mulSmallX(fp5Sub(t10, t8), B1),
    Z: fp5Sub(t8, t9),
    U: fp5Mul(t6, fp5Sub(mulSmallX(t2, B1), t1)),
    T: fp5Add(t8, t9),
  };
}

/** `p (+) p`, in 4 multiplications and 5 squarings. `docs/spec/03-crypto-curve-schnorr.md` §3.6. */
export function pointDouble(p: CurvePoint): CurvePoint {
  const t1: Fp5 = fp5Mul(p.Z, p.T);
  const t2: Fp5 = fp5Mul(t1, p.T);
  const x1: Fp5 = fp5Square(t2);
  const z1: Fp5 = fp5Mul(t1, p.U);
  const t3: Fp5 = fp5Square(p.U);
  const w1: Fp5 = fp5Sub(t2, fp5Mul(fp5Double(fp5Add(p.X, p.Z)), t3));
  const t4: Fp5 = fp5Square(z1);

  const Z: Fp5 = fp5Square(w1);
  return {
    X: mulSmallX(t4, B1_X4),
    Z,
    U: fp5Sub(fp5Sub(fp5Square(fp5Add(w1, z1)), t4), Z),
    T: fp5Sub(fp5Double(x1), fp5Add(fp5ScalarMul(t4, 4n as Fp), Z)),
  };
}

/**
 * `k` repeated doublings.
 *
 * Deliberately a plain loop. The reference's `mDouble` works in an intermediate `(X:W:Z)`
 * representation to save `2M+... ` per step, but it has distinct `k = 0`, `k = 1` and `k >= 2` code
 * paths and buys roughly 30% of one scalar multiplication. `k <= 0` returns `p` unchanged.
 */
export function pointDoubleN(p: CurvePoint, k: number): CurvePoint {
  let acc: CurvePoint = p;
  for (let i: number = 0; i < k; i += 1) {
    acc = pointDouble(acc);
  }
  return acc;
}

/**
 * `(-)p`, which is `(x, -u)`.
 *
 * Negate `U` **or** `T`, never both — flipping both is the identity. `U` is chosen so that the
 * neutral's `U = 0` negates to `0` and stays canonical.
 */
export function pointNegate(p: CurvePoint): CurvePoint {
  return { X: p.X, Z: p.Z, U: fp5Neg(p.U), T: p.T };
}

/**
 * Projective equality, comparing **only** the `u` coordinate: `U1·T2 == U2·T1`.
 *
 * That is sound — `u` determines the point, since `x` is recovered from `w = 1/u` when decoding.
 * Do not "improve" it by also comparing `x`: two representations of the same point can carry
 * different `(X:Z)` scalings, and the reference's vectors rely on the `u`-only test.
 */
export function pointEquals(p: CurvePoint, q: CurvePoint): boolean {
  return fp5Equals(fp5Mul(p.U, q.T), fp5Mul(q.U, p.T));
}

/** `p === N`, which is exactly `U === 0`. */
export function pointIsNeutral(p: CurvePoint): boolean {
  return fp5IsZero(p.U);
}

// ---------------------------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------------------------

/**
 * `encode(p) = T / U` — that is `1/u`, which is `y/x`.
 *
 * This is the canonical serialized form of a group element and the only form that appears on the
 * wire (public keys) or in a hash preimage (the `r` component of the challenge). It is a single
 * `GF(p^5)` element, so 40 bytes.
 *
 * `fp5InverseOrZero` rather than `fp5Inverse`, so the neutral encodes as zero instead of throwing.
 */
export function encodePoint(p: CurvePoint): Fp5 {
  return fp5Mul(p.T, fp5InverseOrZero(p.U));
}

/**
 * Recover the group element whose encoding is `w`, or `null` if there is none. Never throws.
 *
 * Substituting `y = w·x` into the curve equation and dividing by `x` gives
 * `x^2 - (w^2 - a)·x + b = 0`. The two roots multiply to `b`, which is a non-square, so exactly one
 * of them is a square — and the point we want is the one built from the **non-square** root. The
 * square root of the discriminant may therefore be taken with either sign.
 *
 * `w = 0` is the one input where a failed square root still succeeds: `delta` is then `a^2 - 4b`,
 * a non-square, and the special case returns the neutral. `decodePoint(0)` succeeding is deliberate
 * and pinned; rejecting the neutral *public key* belongs to `verify` (`docs/decisions.md` D1).
 *
 * There is no subgroup or cofactor check here, and there must not be: the group has prime order, so
 * every decodable `w` is a valid group element.
 */
export function decodePoint(w: Fp5): CurvePoint | null {
  //  w = 0 decodes to the neutral. Checked first because the sqrt below is expected to fail for it.
  if (fp5IsZero(w)) return NEUTRAL;

  const e: Fp5 = fp5Sub(fp5Square(w), CURVE_A);
  const delta: Fp5 = fp5Sub(fp5Square(e), CURVE_4B); //                 e^2 - 4b
  const { root, exists } = fp5Sqrt(delta);
  if (!exists) return null;

  const x1: Fp5 = fp5ScalarMul(fp5Add(e, root), INV_TWO);
  const x2: Fp5 = fp5ScalarMul(fp5Sub(e, root), INV_TWO);
  //  Keep the NON-square root. `fp5Legendre` is `1` for a non-zero square, `p-1` for a non-square.
  const x: Fp5 = fp5Legendre(x1) === 1n ? x2 : x1;

  return { X: x, Z: FP5_ONE, U: FP5_ONE, T: w };
}

// ---------------------------------------------------------------------------------------------
// Affine conversion
// ---------------------------------------------------------------------------------------------

/** `(X:Z, U:T)` to `(x, u)`. Two inversions; prefer {@link batchToAffine} for more than one point. */
export function pointToAffine(p: CurvePoint): AffinePoint {
  return {
    x: fp5Mul(p.X, fp5InverseOrZero(p.Z)),
    u: fp5Mul(p.U, fp5InverseOrZero(p.T)),
  };
}

/**
 * Montgomery's trick: convert `m` points with a single `GF(p^5)` inversion.
 *
 * Accumulates the running product of every `Z` and `T`, inverts once, then walks backwards peeling
 * the denominators off in reverse. This is what makes the scalar-multiplication window table
 * affordable, since an inversion costs on the order of a hundred multiplications.
 */
export function batchToAffine(ps: readonly CurvePoint[]): AffinePoint[] {
  const m: number = ps.length;
  if (m === 0) return [];

  //  prefix[2i] is the product of all denominators before Z_i; prefix[2i+1] adds Z_i.
  const prefix: Fp5[] = new Array<Fp5>(2 * m);
  let running: Fp5 = FP5_ONE;
  for (let i: number = 0; i < m; i += 1) {
    const pt: CurvePoint = ps[i] as CurvePoint;
    prefix[2 * i] = running;
    running = fp5Mul(running, pt.Z);
    prefix[2 * i + 1] = running;
    running = fp5Mul(running, pt.T);
  }

  let inv: Fp5 = fp5InverseOrZero(running);
  const out: AffinePoint[] = new Array<AffinePoint>(m);
  for (let i: number = m - 1; i >= 0; i -= 1) {
    const pt: CurvePoint = ps[i] as CurvePoint;
    const tInv: Fp5 = fp5Mul(prefix[2 * i + 1] as Fp5, inv);
    inv = fp5Mul(inv, pt.T);
    const zInv: Fp5 = fp5Mul(prefix[2 * i] as Fp5, inv);
    inv = fp5Mul(inv, pt.Z);
    out[i] = { x: fp5Mul(pt.X, zInv), u: fp5Mul(pt.U, tInv) };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------------------------

/**
 * Does `p` lie on `E`? A test and assertion helper, not part of any hot path.
 *
 * Stated in `(x, u)` rather than `(x, y)`: substituting `y = x/u` into `y^2 = x·(x^2 + a·x + b)` and
 * dividing by `x` gives `x = u^2·(x^2 + a·x + b)`, which also holds for the neutral `(0, 0)`.
 *
 * Note this cannot distinguish a group element from that element plus `N` under ordinary curve
 * addition — both are on `E`, and they share a `u`. It is a sanity check on arithmetic, never a
 * validity check on decoded input; decoding is what establishes membership, and the group has
 * cofactor 1 so there is nothing further to verify.
 */
export function pointIsOnCurve(p: CurvePoint): boolean {
  const { x, u } = pointToAffine(p);
  const rhs: Fp5 = fp5Mul(
    fp5Square(u),
    fp5Add(fp5Add(fp5Square(x), fp5Mul(CURVE_A, x)), CURVE_B),
  );
  return fp5Equals(x, rhs);
}
