/**
 * Scalar multiplication: `[s]P`, `[s]G` and `[s]G (+) [e]P`.
 *
 * This is the first unit where the whole crypto stack is exercised end to end, so the tests are
 * ordered by how much they localise a failure:
 *
 * 1. **`encode([1]G) === [4, 0, 0, 0, 0]`** — one digit, one window entry, no doubling chain.
 * 2. **Window construction** — `makeWindow(G)` against a naive `win[i] = [i+1]G` loop written here
 *    from `pointAdd` alone. The `[i+1]` versus `[i]` off-by-one is the trap this catches, and it
 *    produces a result wrong by a multiple of `P` that looks like a field bug.
 * 3. **Lookup** — all 32 digits, branchless against variable-time, and digit `0` against the affine
 *    neutral. There is no `win[-1]`.
 * 4. **Vectors** — all 20 rows of `curve.json -> cases` (limbs and 40-byte encoding), then
 *    `mulScalar(G, s)` against `mulGenerator(s)` so the fixed-base and variable-base paths are shown
 *    to agree, then all 16 rows of `schnorr.json -> cases` for public-key derivation, which is the
 *    check that the window, the recoding and the group law are simultaneously right.
 * 5. **Laws** — `[a]G (+) [b]G == [a+b]G`, `[a]([b]G) == [ab]G`, `[0]G == N`, `[n]G == N`,
 *    `[s]N == N`, and `mulAddG` against its two-multiplication definition.
 * 6. **Memoisation** — the generator table is unbuilt at import and identical across calls.
 * 7. **A timing tripwire** — 20 `mulGenerator` calls under a generous ceiling. A regression alarm,
 *    not the deployed-Worker gate of `docs/decisions.md` D4.
 *
 * The naive ladder in section 2 is written locally rather than imported, so a bug in `makeWindow`
 * cannot be checked against itself.
 */

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  type Fp5,
  fp5Equals,
  fp5FromLimbs,
  fp5ToBytes,
} from '../../src/crypto/field/fp5.js';
import {
  type AffinePoint,
  type CurvePoint,
  GENERATOR,
  NEUTRAL,
  encodePoint,
  pointAdd,
  pointEquals,
  pointIsNeutral,
  pointIsOnCurve,
  pointNegate,
  pointToAffine,
} from '../../src/crypto/point.js';
import { N, modN, recodeScalar5, scalarFromBytes } from '../../src/crypto/scalar.js';
import {
  WINDOW,
  WINDOW_SIZE,
  generatorWindow,
  generatorWindowIsBuilt,
  lookupWindow,
  lookupWindowVarTime,
  makeWindow,
  mulAddG,
  mulGenerator,
  mulScalar,
  windowIsWellFormed,
} from '../../src/crypto/scalarmul.js';

// ---------------------------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------------------------

interface CurveCase {
  readonly scalarLeHex: string;
  readonly scalar: readonly string[];
  readonly mulGenEncoded: readonly string[];
  readonly mulGenLeBytesHex: string;
  readonly doubleEncoded: readonly string[];
  readonly addGenEncoded: readonly string[];
}

interface CurveVectors {
  readonly generatorEncoded: readonly string[];
  readonly neutralEncoded: readonly string[];
  readonly cases: readonly CurveCase[];
}

interface SchnorrCase {
  readonly privateKeyLeHex: string;
  readonly publicKey: readonly string[];
  readonly publicKeyLeHex: string;
}

interface SchnorrVectors {
  readonly cases: readonly SchnorrCase[];
}

const curveVectors = JSON.parse(
  await readFile(new URL('../../conformance/vectors/curve.json', import.meta.url), 'utf8'),
) as CurveVectors;

const schnorrVectors = JSON.parse(
  await readFile(new URL('../../conformance/vectors/schnorr.json', import.meta.url), 'utf8'),
) as SchnorrVectors;

function el(limbs: readonly string[]): Fp5 {
  return fp5FromLimbs(limbs.map((s) => BigInt(s)));
}

function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hex(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += byte.toString(16).padStart(2, '0');
  return s;
}

function show(a: Fp5): string {
  return `[${a.join(', ')}]`;
}

function expectEq(actual: Fp5, expected: Fp5, what: string): void {
  if (!fp5Equals(actual, expected)) {
    throw new Error(`${what}\n  actual   ${show(actual)}\n  expected ${show(expected)}`);
  }
}

/** splitmix64, the generator the oracle uses. Deterministic, no dependency. */
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

/** A seeded scalar in `[0, N)`, assembled from five 64-bit draws. */
function randomScalar(next: () => bigint): bigint {
  let v = 0n;
  for (let i = 0; i < 5; i += 1) v = (v << 64n) | next();
  return modN(v);
}

function affineEquals(a: AffinePoint, b: AffinePoint): boolean {
  return fp5Equals(a.x, b.x) && fp5Equals(a.u, b.u);
}

// ---------------------------------------------------------------------------------------------
// 0. Memoisation — asserted FIRST, before anything touches the generator table
// ---------------------------------------------------------------------------------------------

describe('generatorWindow memoisation', () => {
  /**
   * Importing the module must perform no work: Cloudflare Workers budgets module evaluation
   * tightly, and building a ~4 KB comb table at import time would be paid on every cold start
   * whether or not the isolate ever signs anything.
   *
   * This loads a FRESH module instance rather than inspecting the shared singleton. Asserting on
   * the singleton only holds when this file runs before every other file that touches the
   * generator — true in isolation, false in the full suite, which is not a property worth
   * depending on.
   */
  test('the table is not built at module scope', async () => {
    const fresh = (await import(
      `../../src/crypto/scalarmul.js?fresh=${Math.random()}`
    )) as typeof import('../../src/crypto/scalarmul.js');

    expect(fresh.generatorWindowIsBuilt()).toBe(false);

    fresh.generatorWindow();
    expect(fresh.generatorWindowIsBuilt()).toBe(true);
  });

  test('builds on first call and returns the identical array afterwards', () => {
    const first = generatorWindow();
    expect(generatorWindowIsBuilt()).toBe(true);
    const second = generatorWindow();
    expect(second).toBe(first);
    expect(mulGenerator(3n)).toBeDefined();
    expect(generatorWindow()).toBe(first);
  });
});

// ---------------------------------------------------------------------------------------------
// 1. The cheapest falsification
// ---------------------------------------------------------------------------------------------

describe('smoke', () => {
  test('encodePoint(mulGenerator(1n)) is [4, 0, 0, 0, 0]', () => {
    expectEq(encodePoint(mulGenerator(1n)), fp5FromLimbs([4n, 0n, 0n, 0n, 0n]), 'encode([1]G)');
    expectEq(encodePoint(mulGenerator(1n)), el(curveVectors.generatorEncoded), 'encode([1]G)');
  });

  test('window parameters are 5 and 16', () => {
    expect(WINDOW).toBe(5);
    expect(WINDOW_SIZE).toBe(16);
    expect(1 << (WINDOW - 1)).toBe(WINDOW_SIZE);
  });

  test('recodeScalar5 produces exactly 64 digits in [-15, 16] with a non-negative top digit', () => {
    const next = splitmix64(0x5eed_0000_0000_0001n);
    for (let i = 0; i < 32; i += 1) {
      const digits = recodeScalar5(randomScalar(next));
      expect(digits.length).toBe(64);
      for (const d of digits) {
        expect(d).toBeGreaterThanOrEqual(-15);
        expect(d).toBeLessThanOrEqual(16);
      }
      expect(digits[63] as number).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Window construction
// ---------------------------------------------------------------------------------------------

describe('makeWindow', () => {
  /**
   * `win[i] = [i+1]P`, built by repeated `pointAdd` and nothing else.
   *
   * Deliberately independent of `makeWindow`'s even/odd build order, so an error in that order
   * cannot cancel out against the expectation.
   */
  function naiveWindow(p: CurvePoint): CurvePoint[] {
    const out: CurvePoint[] = [];
    let acc = p;
    for (let i = 0; i < 16; i += 1) {
      out.push(acc);
      acc = pointAdd(acc, p);
    }
    return out;
  }

  test('makeWindow(G) agrees entry-for-entry with a naive [i+1]G loop', () => {
    const win = makeWindow(GENERATOR);
    const naive = naiveWindow(GENERATOR);
    expect(win.length).toBe(16);
    for (let i = 0; i < 16; i += 1) {
      const asPoint: CurvePoint = {
        X: (win[i] as AffinePoint).x,
        Z: fp5FromLimbs([1n, 0n, 0n, 0n, 0n]),
        U: (win[i] as AffinePoint).u,
        T: fp5FromLimbs([1n, 0n, 0n, 0n, 0n]),
      };
      if (!pointEquals(asPoint, naive[i] as CurvePoint)) {
        throw new Error(`win[${i}] should be [${i + 1}]G`);
      }
      expect(pointIsOnCurve(asPoint)).toBe(true);
    }
  });

  test('the off-by-one is pinned: win[0] = G, win[1] = [2]G, win[15] = [16]G', () => {
    const win = makeWindow(GENERATOR);
    const affine = (p: CurvePoint): AffinePoint => pointToAffine(p);
    expect(affineEquals(win[0] as AffinePoint, affine(GENERATOR))).toBe(true);
    expect(affineEquals(win[1] as AffinePoint, affine(pointAdd(GENERATOR, GENERATOR)))).toBe(true);

    let sixteen = GENERATOR;
    for (let i = 1; i < 16; i += 1) sixteen = pointAdd(sixteen, GENERATOR);
    expect(affineEquals(win[15] as AffinePoint, affine(sixteen))).toBe(true);
  });

  test('windowIsWellFormed accepts the real table and rejects a shifted one', () => {
    const win = makeWindow(GENERATOR);
    expect(windowIsWellFormed(win, GENERATOR)).toBe(true);
    expect(windowIsWellFormed(generatorWindow(), GENERATOR)).toBe(true);

    //  A table built as [i]G instead of [i+1]G — the classic off-by-one.
    const shifted: AffinePoint[] = [pointToAffine(NEUTRAL), ...win.slice(0, 15)];
    expect(windowIsWellFormed(shifted, GENERATOR)).toBe(false);
  });

  test('makeWindow works for a non-affine base point (G has T = 4)', () => {
    //  `pointAddAffine` would be wrong here; the table must be built with the general law.
    const p = mulGenerator(0x1234_5678n);
    expect(windowIsWellFormed(makeWindow(p), p)).toBe(true);
  });

  test('makeWindow(N) is 16 copies of the neutral', () => {
    for (const e of makeWindow(NEUTRAL)) {
      expect(fp5Equals(e.u, fp5FromLimbs([0n, 0n, 0n, 0n, 0n]))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Lookup
// ---------------------------------------------------------------------------------------------

describe('lookupWindow', () => {
  const win = makeWindow(GENERATOR);
  const ZERO = fp5FromLimbs([0n, 0n, 0n, 0n, 0n]);

  test('digit 0 is the affine neutral (0, 0), not win[0]', () => {
    const got = lookupWindow(win, 0);
    expectEq(got.x, ZERO, 'lookup(0).x');
    expectEq(got.u, ZERO, 'lookup(0).u');
    expect(affineEquals(got, win[0] as AffinePoint)).toBe(false);
  });

  test('every digit in [-15, 16] selects the specified entry', () => {
    for (let d = 1; d <= 16; d += 1) {
      expect(affineEquals(lookupWindow(win, d), win[d - 1] as AffinePoint)).toBe(true);
    }
    for (let d = -15; d <= -1; d += 1) {
      const entry = win[-d - 1] as AffinePoint;
      const got = lookupWindow(win, d);
      expectEq(got.x, entry.x, `lookup(${d}).x`);
      //  Negation is (x, u) |-> (x, -u).
      const asPoint: CurvePoint = {
        X: got.x,
        Z: fp5FromLimbs([1n, 0n, 0n, 0n, 0n]),
        U: got.u,
        T: fp5FromLimbs([1n, 0n, 0n, 0n, 0n]),
      };
      const expected = pointNegate({
        X: entry.x,
        Z: fp5FromLimbs([1n, 0n, 0n, 0n, 0n]),
        U: entry.u,
        T: fp5FromLimbs([1n, 0n, 0n, 0n, 0n]),
      });
      expect(pointEquals(asPoint, expected)).toBe(true);
    }
  });

  test('branchless and variable-time lookups agree on all 32 digits', () => {
    for (let d = -15; d <= 16; d += 1) {
      const a = lookupWindow(win, d);
      const b = lookupWindowVarTime(win, d);
      if (!affineEquals(a, b)) throw new Error(`lookup disagreement at digit ${d}`);
    }
  });

  test('the selected entry is [d]G for every digit', () => {
    const one = fp5FromLimbs([1n, 0n, 0n, 0n, 0n]);
    for (let d = -15; d <= 16; d += 1) {
      const got = lookupWindow(win, d);
      const asPoint: CurvePoint = { X: got.x, Z: one, U: got.u, T: one };
      const expected = mulScalar(GENERATOR, modN(BigInt(d)));
      if (!pointEquals(asPoint, expected)) throw new Error(`lookup(${d}) is not [${d}]G`);
    }
  });

  test('lookupWindow contains no `if` on the digit value', async () => {
    const src = await readFile(
      new URL('../../src/crypto/scalarmul.ts', import.meta.url),
      'utf8',
    );
    const start = src.indexOf('export function lookupWindow(');
    const end = src.indexOf('export function lookupWindowVarTime(');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).not.toMatch(/\bif\s*\(/);
    expect(body).not.toMatch(/\?[^.]/); //  no ternary either
    //  The only `win[` index in the body is the loop counter, never the digit.
    const indexed = body.match(/win\[[^\]]*\]/g) ?? [];
    expect(indexed).toEqual(['win[i]']);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Vectors
// ---------------------------------------------------------------------------------------------

describe('curve.json — [s]G for 20 pinned scalars', () => {
  test('the file still has 20 rows', () => {
    expect(curveVectors.cases.length).toBe(20);
  });

  curveVectors.cases.forEach((c, i) => {
    test(`row ${i}: mulGenerator matches mulGenEncoded and mulGenLeBytesHex`, () => {
      const s = scalarFromBytes(unhex(c.scalarLeHex));
      const encoded = encodePoint(mulGenerator(s));
      expectEq(encoded, el(c.mulGenEncoded), `row ${i} limbs`);
      expect(hex(fp5ToBytes(encoded))).toBe(c.mulGenLeBytesHex);
    });

    test(`row ${i}: mulScalar(G, s) agrees with mulGenerator(s)`, () => {
      const s = scalarFromBytes(unhex(c.scalarLeHex));
      expect(pointEquals(mulScalar(GENERATOR, s), mulGenerator(s))).toBe(true);
    });

    test(`row ${i}: [2]([s]G) and [s]G (+) G match doubleEncoded / addGenEncoded`, () => {
      const s = scalarFromBytes(unhex(c.scalarLeHex));
      const p = mulGenerator(s);
      expectEq(encodePoint(mulScalar(p, 2n)), el(c.doubleEncoded), `row ${i} double`);
      expectEq(encodePoint(pointAdd(p, GENERATOR)), el(c.addGenEncoded), `row ${i} add G`);
    });
  });
});

describe('schnorr.json — public-key derivation for 16 pinned private keys', () => {
  test('the file still has 16 rows', () => {
    expect(schnorrVectors.cases.length).toBe(16);
  });

  schnorrVectors.cases.forEach((c, i) => {
    test(`row ${i}: [sk]G encodes to publicKeyLeHex`, () => {
      const sk = scalarFromBytes(unhex(c.privateKeyLeHex));
      const encoded = encodePoint(mulGenerator(sk));
      expectEq(encoded, el(c.publicKey), `row ${i} public key limbs`);
      expect(hex(fp5ToBytes(encoded))).toBe(c.publicKeyLeHex);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Group laws
// ---------------------------------------------------------------------------------------------

describe('scalar multiplication laws (seeded)', () => {
  test('[0]G, [n]G and [s]N are all the neutral', () => {
    expect(pointIsNeutral(mulGenerator(0n))).toBe(true);
    expect(pointIsNeutral(mulScalar(GENERATOR, 0n))).toBe(true);
    //  modN(N) is 0, so [n]G is the neutral rather than G.
    expect(pointIsNeutral(mulGenerator(N))).toBe(true);
    expect(pointIsNeutral(mulScalar(GENERATOR, N))).toBe(true);

    const next = splitmix64(0x5eed_0000_0000_0002n);
    for (let i = 0; i < 8; i += 1) {
      expect(pointIsNeutral(mulScalar(NEUTRAL, randomScalar(next)))).toBe(true);
    }
  });

  test('[a]G (+) [b]G === [a+b]G', () => {
    const next = splitmix64(0x5eed_0000_0000_0003n);
    for (let i = 0; i < 24; i += 1) {
      const a = randomScalar(next);
      const b = randomScalar(next);
      const lhs = pointAdd(mulGenerator(a), mulGenerator(b));
      const rhs = mulGenerator(modN(a + b));
      if (!pointEquals(lhs, rhs)) throw new Error(`additivity failed at draw ${i}`);
    }
  });

  test('[a]([b]G) === [a·b]G', () => {
    const next = splitmix64(0x5eed_0000_0000_0004n);
    for (let i = 0; i < 12; i += 1) {
      const a = randomScalar(next);
      const b = randomScalar(next);
      const lhs = mulScalar(mulGenerator(b), a);
      const rhs = mulGenerator(modN(a * b));
      if (!pointEquals(lhs, rhs)) throw new Error(`associativity failed at draw ${i}`);
    }
  });

  test('mulScalar reduces its scalar: [s]P === [s + n]P and [-1]P === [n-1]P', () => {
    const p = mulGenerator(7n);
    expect(pointEquals(mulScalar(p, 5n), mulScalar(p, 5n + N))).toBe(true);
    expect(pointEquals(mulScalar(p, modN(-1n)), mulScalar(p, N - 1n))).toBe(true);
    expect(pointEquals(mulGenerator(1n + N), GENERATOR)).toBe(true);
  });

  test('small scalars match repeated addition', () => {
    let acc: CurvePoint = NEUTRAL;
    for (let k = 0; k <= 40; k += 1) {
      if (!pointEquals(mulGenerator(BigInt(k)), acc)) throw new Error(`[${k}]G is wrong`);
      if (!pointEquals(mulScalar(GENERATOR, BigInt(k)), acc)) {
        throw new Error(`mulScalar [${k}]G is wrong`);
      }
      acc = pointAdd(acc, GENERATOR);
    }
  });
});

describe('mulAddG', () => {
  test('equals pointAdd(mulGenerator(s), mulScalar(P, e)) for 50 seeded triples', () => {
    const next = splitmix64(0x5eed_0000_0000_0005n);
    for (let i = 0; i < 50; i += 1) {
      const t = randomScalar(next);
      const s = randomScalar(next);
      const e = randomScalar(next);
      const p = mulGenerator(t);
      const lhs = mulAddG(p, s, e);
      const rhs = pointAdd(mulGenerator(s), mulScalar(p, e));
      if (!pointEquals(lhs, rhs)) throw new Error(`mulAddG mismatch at draw ${i}`);
    }
  });

  test('degenerate arguments: zero scalars and the neutral base', () => {
    const p = mulGenerator(12345n);
    expect(pointEquals(mulAddG(p, 0n, 0n), NEUTRAL)).toBe(true);
    expect(pointEquals(mulAddG(p, 3n, 0n), mulGenerator(3n))).toBe(true);
    expect(pointEquals(mulAddG(p, 0n, 3n), mulScalar(p, 3n))).toBe(true);
    expect(pointEquals(mulAddG(NEUTRAL, 9n, 7n), mulGenerator(9n))).toBe(true);
  });

  test('the verification shape works: [s]G (+) [e]P with P = [sk]G recovers [s + e·sk]G', () => {
    const next = splitmix64(0x5eed_0000_0000_0006n);
    for (let i = 0; i < 8; i += 1) {
      const sk = randomScalar(next);
      const s = randomScalar(next);
      const e = randomScalar(next);
      const lhs = mulAddG(mulGenerator(sk), s, e);
      const rhs = mulGenerator(modN(s + e * sk));
      if (!pointEquals(lhs, rhs)) throw new Error(`verification identity failed at draw ${i}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Regression tripwire
// ---------------------------------------------------------------------------------------------

describe('performance tripwire', () => {
  /**
   * A generous ceiling, not a benchmark: 25 ms per `[s]G` on a developer laptop. The real gate is a
   * full `sign()`/`verify()` on a deployed Worker (`docs/decisions.md` D4); this only catches a
   * regression that makes scalar multiplication an order of magnitude slower.
   */
  test('20 mulGenerator calls average under 25 ms each', () => {
    const next = splitmix64(0x5eed_0000_0000_0007n);
    const scalars: bigint[] = [];
    for (let i = 0; i < 20; i += 1) scalars.push(randomScalar(next));

    mulGenerator(scalars[0] as bigint); //  warm the table and the JIT

    const start = performance.now();
    for (const s of scalars) mulGenerator(s);
    const elapsed = performance.now() - start;

    const perCall = elapsed / scalars.length;
    if (perCall > 25) {
      throw new Error(`mulGenerator averaged ${perCall.toFixed(2)} ms per call, ceiling is 25 ms`);
    }
    expect(perCall).toBeLessThanOrEqual(25);
  });
});
