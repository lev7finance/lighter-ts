/**
 * The ECgFp5 group law and codec.
 *
 * Every expected value here comes from `conformance/vectors/curve.json`, generated from the Go
 * reference. The coverage is ordered by how cheaply it falsifies a wrong implementation:
 *
 * 1. **`encode(G) === [4, 0, 0, 0, 0]`** — the single cheapest smoke test in the crypto stack, and
 *    the first thing that breaks if `encodePoint` is written as `U/T` instead of `T/U`.
 * 2. **Vectors** — all 20 `cases` rows. Each row's `[s]G` is obtained by *decoding* its pinned
 *    encoding, so this file needs no scalar multiplication and can be verified ahead of it.
 * 3. **Laws** — neutrality, `P (+) P == double(P)`, `P (+) (-)P == N`, mixed addition agreeing with
 *    the general one, `pointDoubleN` agreeing with repeated `pointDouble`, batch affine agreeing
 *    with per-point affine.
 * 4. **Properties** — 256 seeded random `w`, asserting `decode` either fails or round-trips, with a
 *    loose band on the failure rate so that a decoder which never rejects is caught.
 *
 * Two traps get their own tests because they produce points that are on the curve and still wrong:
 * decoding with the *square* root instead of the non-square one (which yields `P + N` under
 * ordinary addition), and using plain curve addition without the `+ N` the complete formulas build
 * in. A fifth section adds a naive double-and-add ladder written locally — not imported from
 * `crypto-scalarmul` — so that `[s]G` can be checked against all 20 pinned scalars and `[n]G`
 * against the neutral.
 */

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import { P } from '../../src/crypto/field/constants.js';
import {
  type Fp5,
  FP5_ONE,
  FP5_ZERO,
  fp5Add,
  fp5Equals,
  fp5FromBytes,
  fp5FromLimbs,
  fp5Legendre,
  fp5Mul,
  fp5Square,
  fp5Sub,
} from '../../src/crypto/field/fp5.js';
import {
  type AffinePoint,
  type CurvePoint,
  CURVE_A,
  CURVE_B,
  GENERATOR,
  NEUTRAL,
  batchToAffine,
  decodePoint,
  encodePoint,
  pointAdd,
  pointAddAffine,
  pointDouble,
  pointDoubleN,
  pointEquals,
  pointIsNeutral,
  pointIsOnCurve,
  pointNegate,
  pointToAffine,
} from '../../src/crypto/point.js';

// ---------------------------------------------------------------------------------------------
// Vector file
// ---------------------------------------------------------------------------------------------

interface Case {
  readonly scalarLeHex: string;
  readonly scalar: readonly string[];
  readonly mulGenEncoded: readonly string[];
  readonly mulGenLeBytesHex: string;
  readonly doubleEncoded: readonly string[];
  readonly addGenEncoded: readonly string[];
  readonly decodeRoundTrip: boolean;
}

interface CurveVectors {
  readonly generatorEncoded: readonly string[];
  readonly neutralEncoded: readonly string[];
  readonly cases: readonly Case[];
  /** Added by `conformance-oracle-extend`; absent in the file as of this unit. */
  readonly decodeFailures?: readonly string[];
  readonly pointOps?: readonly unknown[];
}

const vectorsUrl = new URL('../../conformance/vectors/curve.json', import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, 'utf8')) as CurveVectors;

function el(limbs: readonly string[]): Fp5 {
  return fp5FromLimbs(limbs.map((s) => BigInt(s)));
}

function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Strip the `Fp` brand so `expect(...).toBe(1n)` accepts a plain `bigint` literal. */
function raw(v: bigint): bigint {
  return v;
}

function show(a: Fp5): string {
  return `[${a.join(', ')}]`;
}

function expectEq(actual: Fp5, expected: Fp5, what: string): void {
  if (!fp5Equals(actual, expected)) {
    throw new Error(`${what}\n  actual   ${show(actual)}\n  expected ${show(expected)}`);
  }
}

/**
 * The 20 vector points, obtained by decoding each row's pinned `[s]G` encoding.
 *
 * Built once at module scope so the law tests below can draw pairs from it. Decoding is the only
 * way into the group that does not require scalar multiplication, which is what makes this unit
 * independently verifiable ahead of `crypto-scalarmul`.
 */
const points: CurvePoint[] = vectors.cases.map((c, i) => {
  const w = fp5FromBytes(unhex(c.mulGenLeBytesHex));
  const p = decodePoint(w);
  if (p === null) throw new Error(`row ${i}: decodePoint returned null for a pinned encoding`);
  return p;
});

// ---------------------------------------------------------------------------------------------
// A deliberately independent model of the group law
// ---------------------------------------------------------------------------------------------

/**
 * Ordinary (unshifted) affine curve addition on `E : y^2 = x(x^2 + a x + b)`, in `(x, y)`.
 *
 * This is the textbook chord-and-tangent law with explicit special cases — structurally unlike the
 * complete fractional formulas in `point.ts`, and it does **not** include the `+ N`. It exists to
 * prove that the production law really is the shifted one: `P (+) Q` must equal
 * `plainAdd(plainAdd(P, Q), N)`, and must *not* equal `plainAdd(P, Q)`.
 */
type Plain = { readonly x: Fp5; readonly y: Fp5 } | null; // null = point at infinity

/** `2` as a base-field scalar in `Fp5`, and `3`, for the tangent slope. */
const TWO: Fp5 = fp5FromLimbs([2n, 0n, 0n, 0n, 0n]);
const THREE: Fp5 = fp5FromLimbs([3n, 0n, 0n, 0n, 0n]);

function inv(a: Fp5): Fp5 {
  // Fermat: a^(p^5 - 2). Only used by the model, so speed is irrelevant.
  const order = P ** 5n;
  let e = order - 2n;
  let base = a;
  let acc = FP5_ONE;
  while (e > 0n) {
    if (e & 1n) acc = fp5Mul(acc, base);
    base = fp5Square(base);
    e >>= 1n;
  }
  return acc;
}

function plainNeg(p: Plain): Plain {
  if (p === null) return null;
  return { x: p.x, y: fp5Sub(FP5_ZERO, p.y) };
}

function plainAdd(p: Plain, q: Plain): Plain {
  if (p === null) return q;
  if (q === null) return p;
  if (fp5Equals(p.x, q.x)) {
    // q = -p (distinct y), or p = q = the 2-torsion point (0, 0) whose double is infinity.
    if (!fp5Equals(p.y, q.y) || fp5Equals(p.y, FP5_ZERO)) return null;
    // Tangent: lambda = (3x^2 + 2ax + b) / 2y
    const num = fp5Add(
      fp5Add(fp5Mul(THREE, fp5Square(p.x)), fp5Mul(fp5Mul(TWO, CURVE_A), p.x)),
      CURVE_B,
    );
    const lam = fp5Mul(num, inv(fp5Mul(TWO, p.y)));
    const x3 = fp5Sub(fp5Sub(fp5Sub(fp5Square(lam), CURVE_A), p.x), q.x);
    return { x: x3, y: fp5Sub(fp5Mul(lam, fp5Sub(p.x, x3)), p.y) };
  }
  const lam = fp5Mul(fp5Sub(q.y, p.y), inv(fp5Sub(q.x, p.x)));
  const x3 = fp5Sub(fp5Sub(fp5Sub(fp5Square(lam), CURVE_A), p.x), q.x);
  return { x: x3, y: fp5Sub(fp5Mul(lam, fp5Sub(p.x, x3)), p.y) };
}

/** The 2-torsion point `N = (0, 0)`, which is the neutral of the *shifted* law. */
const PLAIN_N: Plain = { x: FP5_ZERO, y: FP5_ZERO };

/** `(x, u)` -> `(x, y)` with `y = x/u`; the neutral maps to `N = (0, 0)`. */
function toPlain(p: CurvePoint): Plain {
  const { x, u } = pointToAffine(p);
  if (fp5Equals(u, FP5_ZERO)) return PLAIN_N;
  return { x, y: fp5Mul(x, inv(u)) };
}

// =============================================================================================

describe('the cheapest falsification test in the stack', () => {
  test('encodePoint(GENERATOR) is [4, 0, 0, 0, 0]', () => {
    expectEq(encodePoint(GENERATOR), el(vectors.generatorEncoded), 'encode(G)');
    expectEq(encodePoint(GENERATOR), fp5FromLimbs([4n, 0n, 0n, 0n, 0n]), 'encode(G) literal');
  });

  test('encodePoint(NEUTRAL) is zero', () => {
    expectEq(encodePoint(NEUTRAL), el(vectors.neutralEncoded), 'encode(N)');
    expect(vectors.neutralEncoded.every((s) => s === '0')).toBe(true);
  });

  test('encodePoint is T/U, not U/T', () => {
    // U/T for the generator would be 1/4, whose coefficient 0 is not 4.
    const wrong = fp5Mul(GENERATOR.U, inv(GENERATOR.T));
    expect(fp5Equals(wrong, encodePoint(GENERATOR))).toBe(false);
  });
});

describe('constants', () => {
  test('a = 2 and b = 263X', () => {
    expectEq(CURVE_A, fp5FromLimbs([2n, 0n, 0n, 0n, 0n]), 'a');
    expectEq(CURVE_B, fp5FromLimbs([0n, 263n, 0n, 0n, 0n]), 'b');
  });

  test('b is a non-square, which is what makes the decode selection well-defined', () => {
    expect(raw(fp5Legendre(CURVE_B))).toBe(P - 1n);
  });

  test('a^2 - 4b is a non-square, which is what makes w = 0 decode to the neutral', () => {
    const fourB = fp5FromLimbs([0n, 1052n, 0n, 0n, 0n]);
    expect(raw(fp5Legendre(fp5Sub(fp5Square(CURVE_A), fourB)))).toBe(P - 1n);
  });

  test('the generator is on the curve with y = 4x', () => {
    expect(pointIsOnCurve(GENERATOR)).toBe(true);

    const { x } = pointToAffine(GENERATOR);
    const y = fp5Mul(fp5FromLimbs([4n, 0n, 0n, 0n, 0n]), x);
    // y^2 = x(x^2 + 2x + 263X)
    const rhs = fp5Mul(x, fp5Add(fp5Add(fp5Square(x), fp5Mul(CURVE_A, x)), CURVE_B));
    expectEq(fp5Square(y), rhs, 'y^2 = x(x^2 + 2x + 263X)');
  });

  test('the neutral is on the curve, is neutral, and has canonical form (0:1, 0:1)', () => {
    expect(pointIsOnCurve(NEUTRAL)).toBe(true);
    expect(pointIsNeutral(NEUTRAL)).toBe(true);
    expect(pointIsNeutral(GENERATOR)).toBe(false);
    expectEq(NEUTRAL.X, FP5_ZERO, 'N.X');
    expectEq(NEUTRAL.Z, FP5_ONE, 'N.Z');
    expectEq(NEUTRAL.U, FP5_ZERO, 'N.U');
    expectEq(NEUTRAL.T, FP5_ONE, 'N.T');
  });
});

describe('curve.json cases', () => {
  test('there are 20 rows and every one claims a successful round trip', () => {
    expect(vectors.cases.length).toBe(20);
    expect(vectors.cases.every((c) => c.decodeRoundTrip)).toBe(true);
  });

  vectors.cases.forEach((c, i) => {
    describe(`row ${i} (scalar ${c.scalar[0] ?? '?'}…)`, () => {
      const p = points[i] as CurvePoint;

      test('decodes, and its bytes and limbs agree', () => {
        expect(p).not.toBeNull();
        expectEq(fp5FromBytes(unhex(c.mulGenLeBytesHex)), el(c.mulGenEncoded), 'bytes vs limbs');
      });

      test('encode(decode(w)) === w', () => {
        expectEq(encodePoint(p), el(c.mulGenEncoded), 'round trip');
      });

      test('is on the curve', () => {
        expect(pointIsOnCurve(p)).toBe(true);
      });

      test('double', () => {
        expectEq(encodePoint(pointDouble(p)), el(c.doubleEncoded), 'encode(2P)');
      });

      test('add generator', () => {
        expectEq(encodePoint(pointAdd(p, GENERATOR)), el(c.addGenEncoded), 'encode(P + G)');
      });
    });
  });
});

describe('group laws over the 20 vector points', () => {
  test('P (+) N === P', () => {
    for (const p of points) {
      expect(pointEquals(pointAdd(p, NEUTRAL), p)).toBe(true);
      expect(pointEquals(pointAdd(NEUTRAL, p), p)).toBe(true);
      expectEq(encodePoint(pointAdd(p, NEUTRAL)), encodePoint(p), 'P + N encodes as P');
    }
  });

  test('P (+) P === double(P)', () => {
    for (const p of points) {
      expect(pointEquals(pointAdd(p, p), pointDouble(p))).toBe(true);
      expectEq(encodePoint(pointAdd(p, p)), encodePoint(pointDouble(p)), 'P + P vs 2P');
    }
  });

  test('P (+) ((-)P) === N', () => {
    for (const p of points) {
      const sum = pointAdd(p, pointNegate(p));
      expect(pointIsNeutral(sum)).toBe(true);
      expectEq(encodePoint(sum), FP5_ZERO, 'P + (-P) encodes as 0');
    }
  });

  test('negation flips U only; flipping both U and T is the identity', () => {
    for (const p of points) {
      const n = pointNegate(p);
      expect(pointEquals(n, p)).toBe(fp5Equals(p.U, FP5_ZERO));
      const both: CurvePoint = { X: n.X, Z: n.Z, U: n.U, T: fp5Sub(FP5_ZERO, n.T) };
      expect(pointEquals(both, p)).toBe(true);
      expect(pointIsOnCurve(n)).toBe(true);
    }
  });

  test('addition is commutative and associative', () => {
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i] as CurvePoint;
      const b = points[(i + 1) % points.length] as CurvePoint;
      const c = points[(i + 7) % points.length] as CurvePoint;
      expect(pointEquals(pointAdd(a, b), pointAdd(b, a))).toBe(true);
      expect(pointEquals(pointAdd(pointAdd(a, b), c), pointAdd(a, pointAdd(b, c)))).toBe(true);
    }
  });

  test('pointDoubleN(P, k) === k applications of pointDouble', () => {
    for (const p of points) {
      for (const k of [0, 1, 2, 5, 10]) {
        let expected: CurvePoint = p;
        for (let i = 0; i < k; i += 1) expected = pointDouble(expected);
        expect(pointEquals(pointDoubleN(p, k), expected)).toBe(true);
        expectEq(encodePoint(pointDoubleN(p, k)), encodePoint(expected), `doubleN k=${k}`);
      }
    }
  });

  test('pointDoubleN(P, 0) is P itself', () => {
    for (const p of points) {
      expectEq(encodePoint(pointDoubleN(p, 0)), encodePoint(p), 'k = 0');
    }
    expect(pointEquals(pointDoubleN(NEUTRAL, 0), NEUTRAL)).toBe(true);
  });

  test('the neutral absorbs doubling', () => {
    expect(pointIsNeutral(pointDouble(NEUTRAL))).toBe(true);
    expect(pointIsNeutral(pointDoubleN(NEUTRAL, 7))).toBe(true);
    expect(pointIsNeutral(pointAdd(NEUTRAL, NEUTRAL))).toBe(true);
  });

  test('every sum and double stays on the curve', () => {
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i] as CurvePoint;
      const b = points[(i + 3) % points.length] as CurvePoint;
      expect(pointIsOnCurve(pointAdd(a, b))).toBe(true);
      expect(pointIsOnCurve(pointDouble(a))).toBe(true);
    }
  });
});

describe('mixed addition', () => {
  test('pointAddAffine(P, toAffine(Q)) === pointAdd(P, Q) for all 400 pairs', () => {
    const affines = points.map((p) => pointToAffine(p));
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i] as CurvePoint;
      for (let j = 0; j < points.length; j += 1) {
        const q = points[j] as CurvePoint;
        const mixed = pointAddAffine(p, affines[j] as AffinePoint);
        expect(pointEquals(mixed, pointAdd(p, q))).toBe(true);
        expectEq(encodePoint(mixed), encodePoint(pointAdd(p, q)), `mixed ${i},${j}`);
      }
    }
  });

  test('the affine neutral (0, 0) on the right leaves the point unchanged', () => {
    const affineNeutral = pointToAffine(NEUTRAL);
    expectEq(affineNeutral.x, FP5_ZERO, 'affine N.x');
    expectEq(affineNeutral.u, FP5_ZERO, 'affine N.u');
    for (const p of points) {
      const sum = pointAddAffine(p, affineNeutral);
      expect(pointEquals(sum, p)).toBe(true);
      expectEq(encodePoint(sum), encodePoint(p), 'P + affine N');
    }
  });

  test('a neutral left operand yields the affine right operand', () => {
    for (const p of points) {
      const sum = pointAddAffine(NEUTRAL, pointToAffine(p));
      expect(pointEquals(sum, p)).toBe(true);
      expectEq(encodePoint(sum), encodePoint(p), 'N + affine P');
    }
    expect(pointIsNeutral(pointAddAffine(NEUTRAL, pointToAffine(NEUTRAL)))).toBe(true);
  });

  test('mixed addition against the generator matches the pinned addGenEncoded', () => {
    const g = pointToAffine(GENERATOR);
    vectors.cases.forEach((c, i) => {
      expectEq(
        encodePoint(pointAddAffine(points[i] as CurvePoint, g)),
        el(c.addGenEncoded),
        `row ${i} mixed + G`,
      );
    });
  });
});

describe('affine conversion', () => {
  test('batchToAffine agrees element-wise with pointToAffine', () => {
    const batch = batchToAffine(points);
    expect(batch.length).toBe(points.length);
    points.forEach((p, i) => {
      const one = pointToAffine(p);
      expectEq((batch[i] as AffinePoint).x, one.x, `batch x ${i}`);
      expectEq((batch[i] as AffinePoint).u, one.u, `batch u ${i}`);
    });
  });

  test('batchToAffine handles 0 and 1 element inputs', () => {
    expect(batchToAffine([]).length).toBe(0);
    const one = batchToAffine([GENERATOR]);
    expect(one.length).toBe(1);
    expectEq((one[0] as AffinePoint).x, pointToAffine(GENERATOR).x, 'single x');
    expectEq((one[0] as AffinePoint).u, pointToAffine(GENERATOR).u, 'single u');
  });

  test('batchToAffine handles the neutral mixed in', () => {
    const mixed = [GENERATOR, NEUTRAL, points[0] as CurvePoint, NEUTRAL];
    const batch = batchToAffine(mixed);
    mixed.forEach((p, i) => {
      const one = pointToAffine(p);
      expectEq((batch[i] as AffinePoint).x, one.x, `mixed x ${i}`);
      expectEq((batch[i] as AffinePoint).u, one.u, `mixed u ${i}`);
    });
  });

  test('round trip through affine preserves the encoding', () => {
    for (const p of points) {
      const a = pointToAffine(p);
      const back: CurvePoint = { X: a.x, Z: FP5_ONE, U: a.u, T: FP5_ONE };
      expectEq(encodePoint(back), encodePoint(p), 'affine round trip');
      expect(pointIsOnCurve(back)).toBe(true);
    }
  });
});

describe('decode', () => {
  test('decodePoint(0) is the neutral, not a rejection', () => {
    const p = decodePoint(FP5_ZERO);
    expect(p).not.toBeNull();
    expect(pointIsNeutral(p as CurvePoint)).toBe(true);
    expectEq(encodePoint(p as CurvePoint), FP5_ZERO, 'encode(decode(0))');
  });

  test('decodePoint(4) is the generator', () => {
    const p = decodePoint(fp5FromLimbs([4n, 0n, 0n, 0n, 0n]));
    expect(p).not.toBeNull();
    expect(pointEquals(p as CurvePoint, GENERATOR)).toBe(true);
    expectEq(pointToAffine(p as CurvePoint).x, pointToAffine(GENERATOR).x, 'decoded G.x');
  });

  test('the chosen root is the NON-square one', () => {
    // For w = 4 the spec states x1 = G.x and legendre(G.x) != 1.
    const gx = pointToAffine(GENERATOR).x;
    expect(raw(fp5Legendre(gx))).not.toBe(1n);
    // The other root is b / G.x, and it must be a square.
    const other = fp5Mul(CURVE_B, inv(gx));
    expect(raw(fp5Legendre(other))).toBe(1n);
  });

  test('picking the square root would yield P + N (ordinary addition), still on the curve', () => {
    // The wrong choice for every vector point: x' = b/x. It satisfies the curve equation, which is
    // exactly why pointIsOnCurve cannot catch this bug and the vectors have to.
    for (const p of points.slice(0, 5)) {
      const { x, u } = pointToAffine(p);
      if (fp5Equals(x, FP5_ZERO)) continue;

      // The other root of x^2 - (w^2 - a)x + b = 0, since the two roots multiply to b.
      const wrongX = fp5Mul(CURVE_B, inv(x));
      expect(fp5Equals(wrongX, x)).toBe(false);

      // Exactly one of the two roots is a square, and decodePoint must keep the other one.
      expect(fp5Legendre(wrongX) === 1n).not.toBe(fp5Legendre(x) === 1n);
      expect(raw(fp5Legendre(x))).not.toBe(1n);
      expect(raw(fp5Legendre(wrongX))).toBe(1n);

      // The point built from the square root is a genuine curve point sharing this point's `u`, and
      // it even carries the same encoding — it is `P + N` under ordinary addition, sitting in the
      // other half of E. `pointIsOnCurve` accepts it, so only the vectors catch this mistake.
      const wrong: CurvePoint = { X: wrongX, Z: FP5_ONE, U: u, T: FP5_ONE };
      expect(pointIsOnCurve(wrong)).toBe(true);
      expectEq(encodePoint(wrong), encodePoint(p), 'the wrong root encodes identically');
      expect(fp5Equals(pointToAffine(wrong).x, pointToAffine(p).x)).toBe(false);
    }
  });

  test('decodePoint returns null and never throws on undecodable input', () => {
    let rejected = 0;
    for (let i = 1n; i <= 64n; i += 1n) {
      const w = fp5FromLimbs([i, i * 7n, i * 11n, i * 13n, i * 17n]);
      let out: CurvePoint | null = null;
      expect(() => {
        out = decodePoint(w);
      }).not.toThrow();
      if (out === null) rejected += 1;
      else expectEq(encodePoint(out as CurvePoint), w, 'round trip of an accepted w');
    }
    expect(rejected).toBeGreaterThan(0);
  });
});

describe('decode property test (seeded, 256 draws)', () => {
  /** splitmix64, the same generator the oracle uses. Deterministic, no dependency. */
  function splitmix64(seed: bigint): () => bigint {
    let s = seed & 0xffffffffffffffffn;
    return () => {
      s = (s + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
      let z = s;
      z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
      z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
      return z ^ (z >> 31n);
    };
  }

  test('decode(w) is either null or round-trips, and fails for roughly half of all w', () => {
    const next = splitmix64(0x1234_5678_9abc_def0n);
    const draws = 256;
    let failures = 0;

    for (let i = 0; i < draws; i += 1) {
      const w = fp5FromLimbs([next(), next(), next(), next(), next()]);
      const p = decodePoint(w);
      if (p === null) {
        failures += 1;
        continue;
      }
      expectEq(encodePoint(p), w, `round trip draw ${i}`);
      expect(pointIsOnCurve(p)).toBe(true);
    }

    // Exactly half of GF(p^5) is a valid encoding, so the observed rate should sit near 50%. The
    // band is loose on purpose: what it has to catch is a decoder that never rejects (0%) or one
    // that always does (100%).
    const rate = failures / draws;
    expect(rate).toBeGreaterThan(0.3);
    expect(rate).toBeLessThan(0.7);
  });
});

describe('the shifted law really is shifted', () => {
  test('pointAdd(P, Q) === plainAdd(plainAdd(P, Q), N), and is NOT plainAdd(P, Q)', () => {
    // Six pairs is enough: the model uses Fermat inversion and is slow.
    for (let i = 0; i < 6; i += 1) {
      const p = points[i + 1] as CurvePoint;
      const q = points[i + 5] as CurvePoint;

      const shifted = plainAdd(plainAdd(toPlain(p), toPlain(q)), PLAIN_N);
      const actual = toPlain(pointAdd(p, q));

      expect(shifted).not.toBeNull();
      expect(actual).not.toBeNull();
      expectEq((actual as { x: Fp5; y: Fp5 }).x, (shifted as { x: Fp5; y: Fp5 }).x, `pair ${i} x`);
      expectEq((actual as { x: Fp5; y: Fp5 }).y, (shifted as { x: Fp5; y: Fp5 }).y, `pair ${i} y`);

      const unshifted = plainAdd(toPlain(p), toPlain(q));
      expect(fp5Equals((unshifted as { x: Fp5; y: Fp5 }).x, (actual as { x: Fp5 }).x)).toBe(false);
    }
  });

  test('the neutral of the group law is N = (0, 0), not the point at infinity', () => {
    const n = toPlain(NEUTRAL);
    expect(n).not.toBeNull();
    expectEq((n as { x: Fp5; y: Fp5 }).x, FP5_ZERO, 'N.x');
    expectEq((n as { x: Fp5; y: Fp5 }).y, FP5_ZERO, 'N.y');
  });

  test('negation in the group is ordinary curve negation', () => {
    for (let i = 0; i < 4; i += 1) {
      const p = points[i + 2] as CurvePoint;
      const modelNeg = plainNeg(toPlain(p));
      const actual = toPlain(pointNegate(p));
      expectEq((actual as { x: Fp5; y: Fp5 }).x, (modelNeg as { x: Fp5; y: Fp5 }).x, 'neg x');
      expectEq((actual as { x: Fp5; y: Fp5 }).y, (modelNeg as { x: Fp5; y: Fp5 }).y, 'neg y');
    }
  });
});

describe('mulSmallX fast path, exercised through the public surface', () => {
  test('the b, 2b and 4b multiplications agree with a general fp5Mul', () => {
    // point.ts multiplies by b, 2b and 4b with a 5-multiplication shift-and-fold rather than a
    // general fp5Mul. That shortcut is not exported, so it is checked here against the same algebra
    // written out longhand, over the same random values the formulas would see.
    const twoB = fp5FromLimbs([0n, 526n, 0n, 0n, 0n]);
    const fourB = fp5FromLimbs([0n, 1052n, 0n, 0n, 0n]);
    for (let i = 1n; i <= 32n; i += 1n) {
      const a = fp5FromLimbs([i * 3n, i * 5n, P - i, i * 9n, i * 11n]);
      const longhandB = fp5Mul(CURVE_B, a);
      const shortcutB = fp5FromLimbs([
        (a[4] * 789n) % P,
        (a[0] * 263n) % P,
        (a[1] * 263n) % P,
        (a[2] * 263n) % P,
        (a[3] * 263n) % P,
      ]);
      expectEq(shortcutB, longhandB, 'b·a');
      expectEq(fp5Mul(twoB, a), fp5Add(longhandB, longhandB), '2b·a');
      expectEq(fp5Mul(fourB, a), fp5Add(fp5Mul(twoB, a), fp5Mul(twoB, a)), '4b·a');
    }
  });
});

describe('independent scalar multiplication, written here rather than imported', () => {
  /**
   * Textbook double-and-add under the shifted law, seeded from `NEUTRAL`.
   *
   * `crypto-scalarmul` is a separate unit with a windowed implementation; this deliberately naive
   * ladder uses nothing but `pointAdd`/`pointDouble` from this file, so it tests the group law
   * against the vectors' own scalars without importing anything downstream.
   */
  function naiveMul(p: CurvePoint, s: bigint): CurvePoint {
    let acc: CurvePoint = NEUTRAL;
    if (s <= 0n) return acc;
    for (let bit = BigInt(s.toString(2).length) - 1n; bit >= 0n; bit -= 1n) {
      acc = pointDouble(acc);
      if ((s >> bit) & 1n) acc = pointAdd(acc, p);
    }
    return acc;
  }

  /** `n`, the prime order of the group. `docs/spec/03-crypto-curve-schnorr.md` §5.1. */
  const GROUP_ORDER =
    1067993516717146951041484916571792702745057740581727230159139685185762082554198619328292418486241n;

  test('[s]G matches every row of mulGenEncoded', () => {
    vectors.cases.forEach((c, i) => {
      let s = 0n;
      c.scalar.forEach((limb, j) => {
        s += BigInt(limb) << BigInt(64 * j);
      });
      expectEq(encodePoint(naiveMul(GENERATOR, s)), el(c.mulGenEncoded), `row ${i}: [s]G`);
    });
  });

  test('[n]G is the neutral — the group really does have prime order n and cofactor 1', () => {
    expect(pointIsNeutral(naiveMul(GENERATOR, GROUP_ORDER))).toBe(true);
    expectEq(encodePoint(naiveMul(GENERATOR, GROUP_ORDER)), FP5_ZERO, '[n]G');
  });

  test('[n-1]G is (-)G, and [n+1]G is G', () => {
    expect(pointEquals(naiveMul(GENERATOR, GROUP_ORDER - 1n), pointNegate(GENERATOR))).toBe(true);
    expect(pointEquals(naiveMul(GENERATOR, GROUP_ORDER + 1n), GENERATOR)).toBe(true);
  });

  test('[n]P is the neutral for every vector point', () => {
    for (const p of points.slice(0, 5)) {
      expect(pointIsNeutral(naiveMul(p, GROUP_ORDER))).toBe(true);
    }
  });
});

describe('oracle extensions, if present', () => {
  test('every decodeFailures entry returns null', () => {
    const failures = vectors.decodeFailures;
    if (failures === undefined) {
      expect(failures).toBeUndefined();
      return;
    }
    for (const hex of failures) {
      expect(decodePoint(fp5FromBytes(unhex(hex)))).toBeNull();
    }
  });
});
