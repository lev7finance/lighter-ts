/**
 * `GF(p^5)` is the type the protocol moves around: a public key, a message hash and a Poseidon2
 * `hashToQuinticExtension` output are all elements of this field. Several operations here have more
 * than one mathematically valid answer and only one wire answer, so the coverage is deliberately
 * layered:
 *
 * 1. **Vectors** — all 46 `cases` rows of `conformance/vectors/gfp5.json`, generated from the Go
 *    reference, across every emitted key.
 * 2. **Traps** — the specific rows that punish a plausible-looking implementation: the `b = 0` row
 *    whose `divAB` zeros are a generator convention rather than a result, and the `a = 0` row where
 *    `sqrt` exists, `sgn0` is true and `legendre` is `0`.
 * 3. **Goldens** — the hand-checkable values from `docs/spec/01-crypto-field.md` §13, including the
 *    reference's own `0x1234567890ABCDEF…` vector, its Go-test-suite companions, and `263`.
 * 4. **Properties** — 10^4 seeded pseudo-random elements per law, plus agreement with a deliberately
 *    naive schoolbook model that reduces after every single operation. A fixed-seed vector file can
 *    miss a lazy-reduction overflow; the model cannot.
 */

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import { P } from '../../../src/crypto/field/constants.js';
import type { Fp } from '../../../src/crypto/field/fp.js';
import {
  type Fp5,
  FP5_ONE,
  FP5_TWO,
  FP5_ZERO,
  fp5Add,
  fp5CanonicalSqrt,
  fp5Div,
  fp5Double,
  fp5Equals,
  fp5ExpPow2,
  fp5FromBytes,
  fp5FromBytesStrict,
  fp5FromFp,
  fp5FromLimbs,
  fp5FromU64,
  fp5Frobenius,
  fp5Inverse,
  fp5InverseOrZero,
  fp5IsZero,
  fp5Legendre,
  fp5Mul,
  fp5Neg,
  fp5Norm,
  fp5RepeatedFrobenius,
  fp5ScalarMul,
  fp5Sgn0,
  fp5Sqrt,
  fp5Square,
  fp5Sub,
  fp5ToBytes,
  fp5Triple,
} from '../../../src/crypto/field/fp5.js';

// ---------------------------------------------------------------------------------------------
// Vector file
// ---------------------------------------------------------------------------------------------

interface Case {
  readonly a: readonly string[];
  readonly b: readonly string[];
  readonly add: readonly string[];
  readonly sub: readonly string[];
  readonly mul: readonly string[];
  readonly squareA: readonly string[];
  readonly doubleA: readonly string[];
  readonly tripleA: readonly string[];
  readonly negA: readonly string[];
  readonly inverseA: readonly string[];
  readonly divAB: readonly string[];
  readonly frobeniusA: readonly string[];
  readonly frobenius2A: readonly string[];
  readonly scalarMulA: readonly string[];
  readonly legendreA: string;
  readonly sgn0A: boolean;
  readonly sqrtA: readonly string[];
  readonly sqrtAExists: boolean;
  readonly canonicalSqrtA: readonly string[];
  readonly canonicalSqrtAExists: boolean;
  readonly aLeBytesHex: string;
}

const vectorsUrl = new URL('../../../conformance/vectors/gfp5.json', import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, 'utf8')) as {
  readonly bytes: number;
  readonly cases: readonly Case[];
};

/** The index of the row whose `b` is zero. Asserted below rather than hard-coded blindly. */
const ZERO_DIVISOR_ROW = 2;
/** The index of the row whose `a` is zero. */
const ZERO_ELEMENT_ROW = 0;

/** Vector coefficients are decimal strings; every one of them is canonical. */
function el(limbs: readonly string[]): Fp5 {
  return fp5FromLimbs(limbs.map((s) => BigInt(s)));
}

/** Strip the `Fp` brand so `expect(...).toBe(1n)` accepts a plain `bigint` literal. */
function raw(v: Fp): bigint {
  return v;
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const byte of bytes) s += byte.toString(16).padStart(2, '0');
  return s;
}

function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Structural comparison that prints both tuples on failure. */
function expectEq(actual: Fp5, expected: Fp5, what: string): void {
  if (!fp5Equals(actual, expected)) {
    throw new Error(`${what}\n  actual   ${actual.join(',')}\n  expected ${expected.join(',')}`);
  }
}

// ---------------------------------------------------------------------------------------------
// A deliberately naive independent model
// ---------------------------------------------------------------------------------------------

/**
 * Schoolbook `GF(p^5)` multiplication that reduces with `%` after *every* operation, folding
 * `X^5 = 3` term by term. Slow, obviously correct, and structurally unlike the lazily-reduced
 * production path — so it catches an accumulator that overflows its claimed bound.
 */
function naiveMul(a: readonly bigint[], b: readonly bigint[]): bigint[] {
  const c: bigint[] = [0n, 0n, 0n, 0n, 0n];
  for (let i = 0; i < 5; i += 1) {
    for (let j = 0; j < 5; j += 1) {
      const term = ((a[i] ?? 0n) % P) * ((b[j] ?? 0n) % P) % P;
      const k = i + j;
      if (k < 5) {
        c[k] = ((c[k] ?? 0n) + term) % P;
      } else {
        c[k - 5] = ((c[k - 5] ?? 0n) + (3n * term) % P) % P;
      }
    }
  }
  return c;
}

/** splitmix64 — a seeded generator, so a failing property test is reproducible. */
function splitmix64(seed: bigint): () => bigint {
  let state = seed & 0xffffffffffffffffn;
  return (): bigint => {
    state = (state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    return z ^ (z >> 31n);
  };
}

function randomElements(seed: bigint, count: number): Fp5[] {
  const next = splitmix64(seed);
  const out: Fp5[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(fp5FromLimbs([next(), next(), next(), next(), next()]));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 1. Vectors
// ---------------------------------------------------------------------------------------------

describe('gfp5.json conformance', () => {
  test('the corpus is the expected shape', () => {
    expect(vectors.bytes).toBe(40);
    expect(vectors.cases.length).toBe(46);
    expect(vectors.cases[ZERO_DIVISOR_ROW]?.b.every((s) => s === '0')).toBe(true);
    expect(vectors.cases[ZERO_ELEMENT_ROW]?.a.every((s) => s === '0')).toBe(true);
  });

  test('every row reproduces exactly', () => {
    vectors.cases.forEach((c, i) => {
      const a = el(c.a);
      const b = el(c.b);
      const at = (what: string): string => `case ${i}: ${what}`;

      expectEq(fp5Add(a, b), el(c.add), at('add'));
      expectEq(fp5Sub(a, b), el(c.sub), at('sub'));
      expectEq(fp5Mul(a, b), el(c.mul), at('mul'));
      expectEq(fp5Square(a), el(c.squareA), at('squareA'));
      expectEq(fp5Double(a), el(c.doubleA), at('doubleA'));
      expectEq(fp5Triple(a), el(c.tripleA), at('tripleA'));
      expectEq(fp5Neg(a), el(c.negA), at('negA'));
      expectEq(fp5InverseOrZero(a), el(c.inverseA), at('inverseA'));
      expectEq(fp5Frobenius(a), el(c.frobeniusA), at('frobeniusA'));
      expectEq(fp5RepeatedFrobenius(a, 1), el(c.frobeniusA), at('repeatedFrobenius(1)'));
      expectEq(fp5RepeatedFrobenius(a, 2), el(c.frobenius2A), at('frobenius2A'));

      // scalarMulA is a *base-field* scalar multiplication by b's coefficient 0.
      expectEq(fp5ScalarMul(a, b[0]), el(c.scalarMulA), at('scalarMulA'));

      // The zero-divisor row's divAB zeros are a generator convention, not a result — see below.
      if (i !== ZERO_DIVISOR_ROW) {
        expectEq(fp5Div(a, b), el(c.divAB), at('divAB'));
      }

      expect(fp5Legendre(a).toString()).toBe(c.legendreA);
      expect(fp5Sgn0(a)).toBe(c.sgn0A);

      const root = fp5Sqrt(a);
      expect(root.exists).toBe(c.sqrtAExists);
      expectEq(root.root, el(c.sqrtA), at('sqrtA'));

      const canonical = fp5CanonicalSqrt(a);
      expect(canonical.exists).toBe(c.canonicalSqrtAExists);
      expectEq(canonical.root, el(c.canonicalSqrtA), at('canonicalSqrtA'));

      const bytes = fp5ToBytes(a);
      expect(bytes.length).toBe(vectors.bytes);
      expect(hex(bytes)).toBe(c.aLeBytesHex);
      expectEq(fp5FromBytes(unhex(c.aLeBytesHex)), a, at('fromBytes round-trip'));
      expectEq(fp5FromBytesStrict(unhex(c.aLeBytesHex)), a, at('fromBytesStrict round-trip'));
    });
  });

  test('legendre is a three-valued FIELD ELEMENT, never a boolean', () => {
    const seen = new Set(vectors.cases.map((c) => c.legendreA));
    expect(seen).toEqual(new Set(['0', '1', '18446744069414584320']));
    // Every emitted value is one of the three, and the non-square value is p - 1.
    for (const c of vectors.cases) {
      const l = fp5Legendre(el(c.a));
      expect(l === 0n || l === 1n || l === P - 1n).toBe(true);
      // "is a square" is `l in {0, 1}` — NOT `l === 1`.
      expect(l === 0n || l === 1n).toBe(c.sqrtAExists);
    }
  });

  test('a square root squares back to its input on every row that has one', () => {
    for (const c of vectors.cases) {
      const a = el(c.a);
      const { root, exists } = fp5Sqrt(a);
      if (!exists) continue;
      expectEq(fp5Square(root), a, 'sqrt(a)^2 === a');
      const { root: canonical } = fp5CanonicalSqrt(a);
      expectEq(fp5Square(canonical), a, 'canonicalSqrt(a)^2 === a');
      // canonicalSqrt returns one of the two roots.
      expect(fp5Equals(canonical, root) || fp5Equals(canonical, fp5Neg(root))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The two trap rows
// ---------------------------------------------------------------------------------------------

describe('trap rows', () => {
  test(`case ${ZERO_DIVISOR_ROW}: division by zero THROWS — divAB's zeros are a decoy`, () => {
    const c = vectors.cases[ZERO_DIVISOR_ROW];
    if (c === undefined) throw new Error('missing row');
    const a = el(c.a);
    const b = el(c.b);

    expect(fp5IsZero(b)).toBe(true);
    expect(c.divAB.every((s) => s === '0')).toBe(true);

    // The Go Div panics, so the oracle zero-fills. Comparing against those zeros would "pass" an
    // implementation that returns garbage for every division by zero.
    expect(() => fp5Div(a, b)).toThrow();
    expect(() => fp5Div(a, FP5_ZERO)).toThrow();
    expect(() => fp5Inverse(FP5_ZERO)).toThrow();

    // ...while the total variant must NOT throw. The sqrt path depends on it.
    expect(fp5IsZero(fp5InverseOrZero(FP5_ZERO))).toBe(true);
  });

  test(`case ${ZERO_ELEMENT_ROW}: zero IS a square, sgn0(0) is true, legendre(0) is 0`, () => {
    const c = vectors.cases[ZERO_ELEMENT_ROW];
    if (c === undefined) throw new Error('missing row');
    expect(c.sqrtAExists).toBe(true);
    expect(c.canonicalSqrtAExists).toBe(true);
    expect(c.sgn0A).toBe(true);
    expect(c.legendreA).toBe('0');
    expect(c.inverseA.every((s) => s === '0')).toBe(true);

    const sqrt = fp5Sqrt(FP5_ZERO);
    expect(sqrt.exists).toBe(true);
    expect(fp5IsZero(sqrt.root)).toBe(true);

    const canonical = fp5CanonicalSqrt(FP5_ZERO);
    expect(canonical.exists).toBe(true);
    expect(fp5IsZero(canonical.root)).toBe(true);

    expect(fp5Sgn0(FP5_ZERO)).toBe(true);
    expect(raw(fp5Legendre(FP5_ZERO))).toBe(0n);
    expect(raw(fp5Norm(FP5_ZERO))).toBe(0n);
    expect(fp5IsZero(fp5InverseOrZero(FP5_ZERO))).toBe(true);
  });

  test('sgn0 is TRUE for EVEN coefficient 0 — inverted vs RFC 9380, on purpose', () => {
    expect(fp5Sgn0(FP5_ZERO)).toBe(true);
    expect(fp5Sgn0(FP5_ONE)).toBe(false);
    expect(fp5Sgn0(FP5_TWO)).toBe(true);
    // p - 1 is even; the RFC 9380 / Rust convention would call this "odd" and return the opposite.
    expect(fp5Sgn0(fp5Neg(FP5_ONE))).toBe(true);
    // Only coefficient 0 is consulted.
    expect(fp5Sgn0(fp5FromLimbs([2n, 1n, 1n, 1n, 1n]))).toBe(true);
    expect(fp5Sgn0(fp5FromLimbs([3n, 0n, 0n, 0n, 0n]))).toBe(false);
  });

  test('canonicalSqrt selects the ODD coefficient 0, and negates unconditionally when it is 0', () => {
    for (const c of vectors.cases) {
      const a = el(c.a);
      const { root, exists } = fp5Sqrt(a);
      if (!exists) continue;
      const { root: canonical } = fp5CanonicalSqrt(a);
      if (fp5Sgn0(root)) {
        expectEq(canonical, fp5Neg(root), 'sgn0(root) -> neg(root)');
      } else {
        expectEq(canonical, root, '!sgn0(root) -> root');
        expect(canonical[0] & 1n).toBe(1n);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Golden values — docs/spec/01-crypto-field.md §13
// ---------------------------------------------------------------------------------------------

describe('spec §13 golden values', () => {
  const A = fp5FromLimbs([
    0x1234567890abcdefn,
    0x0fedcba987654321n,
    0x1122334455667788n,
    0x8877665544332211n,
    0xaabbccddeeff0011n,
  ]);

  test('A is the documented decimal tuple', () => {
    expect(A.map(String)).toEqual([
      '1311768467294899695',
      '1147797409030816545',
      '1234605616436508552',
      '9833440827789222417',
      '12302652060662169617',
    ]);
  });

  test('square, inverse, Frobenius powers', () => {
    expectEq(
      fp5Square(A),
      fp5FromLimbs([
        2711468769317614959n,
        15562737284369360677n,
        48874032493986270n,
        11211402278708723253n,
        2864528669572451733n,
      ]),
      'square(A)',
    );
    expectEq(
      fp5InverseOrZero(A),
      fp5FromLimbs([
        10760985268447604442n,
        1770001646280707407n,
        826117924202660585n,
        45414427571889187n,
        8256636258983026155n,
      ]),
      'inverseOrZero(A)',
    );
    expectEq(
      fp5Frobenius(A),
      fp5FromLimbs([
        1311768467294899695n,
        5234265561494296110n,
        6204816484784411482n,
        8858034429214283719n,
        17855579289599571296n,
      ]),
      'frobenius(A)',
    );
    expectEq(
      fp5RepeatedFrobenius(A, 2),
      fp5FromLimbs([
        1311768467294899695n,
        13803063250989569623n,
        15493897884983376685n,
        5352534261435721987n,
        1417711473305569785n,
      ]),
      'frobenius^2(A)',
    );
  });

  test('legendre, sgn0, sqrt and the 40-byte encoding', () => {
    expect(raw(fp5Legendre(A))).toBe(1n);
    expect(fp5Sgn0(A)).toBe(false);

    const { root, exists } = fp5Sqrt(A);
    expect(exists).toBe(true);
    expectEq(
      root,
      fp5FromLimbs([
        8227384794290457999n,
        13057635167901404592n,
        15133905870921849524n,
        9153259836227416723n,
        3937402200536404673n,
      ]),
      'sqrt(A).root',
    );

    expect(hex(fp5ToBytes(A))).toBe(
      'efcdab907856341221436587a9cbed0f887766554433221111223344556677881100ffeeddccbbaa',
    );
    expectEq(fp5FromBytes(fp5ToBytes(A)), A, 'A round-trips');
  });

  test('263 — the curve B coefficient — is a known non-square', () => {
    const b = fp5FromU64(263n);
    expect(raw(fp5Legendre(b))).toBe(P - 1n);
    const { root, exists } = fp5Sqrt(b);
    expect(exists).toBe(false);
    expect(fp5IsZero(root)).toBe(true);
    const canonical = fp5CanonicalSqrt(b);
    expect(canonical.exists).toBe(false);
    expect(fp5IsZero(canonical.root)).toBe(true);
  });

  test('zero: legendre 0, sqrt exists, inverseOrZero is zero', () => {
    expect(raw(fp5Legendre(FP5_ZERO))).toBe(0n);
    expect(fp5Sqrt(FP5_ZERO)).toEqual({ root: FP5_ZERO, exists: true });
    expect(fp5InverseOrZero(FP5_ZERO)).toEqual(FP5_ZERO);
  });

  test('reference Go-test-suite rows against the all-ones vector', () => {
    // Five limbs of 0xFFFFFFFFFFFFFFFF, which reduce to 4294967294 each — truncation would give p-1.
    const allOnes = fp5FromLimbs([
      0xffffffffffffffffn,
      0xffffffffffffffffn,
      0xffffffffffffffffn,
      0xffffffffffffffffn,
      0xffffffffffffffffn,
    ]);
    expect(allOnes.map(String)).toEqual(Array<string>(5).fill('4294967294'));

    expectEq(
      fp5Add(A, allOnes),
      fp5FromLimbs([
        1311768471589866989n,
        1147797413325783839n,
        1234605620731475846n,
        9833440832084189711n,
        12302652064957136911n,
      ]),
      'add(A, ALL_ONES)',
    );
    expectEq(
      fp5Sub(A, allOnes),
      fp5FromLimbs([
        1311768462999932401n,
        1147797404735849251n,
        1234605612141541258n,
        9833440823494255123n,
        12302652056367202323n,
      ]),
      'sub(A, ALL_ONES)',
    );
    expectEq(
      fp5Mul(A, allOnes),
      fp5FromLimbs([
        12801331769143413385n,
        14031114708135177824n,
        4192851210753422088n,
        14031114723597060086n,
        4193451712464626164n,
      ]),
      'mul(A, ALL_ONES)',
    );
  });

  test('reference sgn0, canonicalSqrt and non-square rows', () => {
    expect(
      fp5Sgn0(
        fp5FromLimbs([
          7146494650688613286n,
          2524706331227574337n,
          2805008444831673606n,
          10342159727506097401n,
          5582307593199735986n,
        ]),
      ),
    ).toBe(true);

    const c = fp5FromLimbs([
      17397692312497920520n,
      4597259071399531684n,
      15835726694542307225n,
      16979717054676631815n,
      12876043227925845432n,
    ]);
    expectEq(
      fp5Sqrt(c).root,
      fp5FromLimbs([
        2186625679060950916n,
        16242270403796443921n,
        8025227062761033539n,
        13828276184878410469n,
        2890553496999551182n,
      ]),
      'sqrt of the reference canonicalSqrt input',
    );
    expectEq(
      fp5CanonicalSqrt(c).root,
      fp5FromLimbs([
        16260118390353633405n,
        2204473665618140400n,
        10421517006653550782n,
        4618467884536173852n,
        15556190572415033139n,
      ]),
      'canonicalSqrt of the reference input',
    );

    expect(
      fp5Sqrt(
        fp5FromLimbs([
          3558249639744866495n,
          2615658757916804776n,
          14375546700029059319n,
          16160052538060569780n,
          8366525948816396307n,
        ]),
      ).exists,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Codec and guards
// ---------------------------------------------------------------------------------------------

describe('codec', () => {
  /** 40 bytes whose limb 0 is exactly `p + 1` and whose remaining limbs are canonical. */
  function nonCanonicalBytes(): Uint8Array {
    const out = new Uint8Array(40);
    new DataView(out.buffer).setBigUint64(0, P + 1n, true);
    return out;
  }

  test('fp5FromBytes REDUCES a non-canonical limb (D3: the interoperable default)', () => {
    const decoded = fp5FromBytes(nonCanonicalBytes());
    expect(raw(decoded[0])).toBe(1n);
    expect(decoded.slice(1).every((c) => c === 0n)).toBe(true);
  });

  test('fp5FromBytesStrict REJECTS the same input', () => {
    expect(() => fp5FromBytesStrict(nonCanonicalBytes())).toThrow();
  });

  test('a limb of exactly p is reduced to 0 / rejected', () => {
    const out = new Uint8Array(40);
    new DataView(out.buffer).setBigUint64(8 * 3, P, true);
    expect(fp5IsZero(fp5FromBytes(out))).toBe(true);
    expect(() => fp5FromBytesStrict(out)).toThrow();
  });

  test('both decoders reject every length other than 40', () => {
    for (const n of [0, 1, 8, 32, 39, 41, 80]) {
      expect(() => fp5FromBytes(new Uint8Array(n))).toThrow();
      expect(() => fp5FromBytesStrict(new Uint8Array(n))).toThrow();
    }
  });

  test('decoding respects byteOffset on a shared buffer', () => {
    const backing = new Uint8Array(48);
    backing.set(fp5ToBytes(FP5_TWO), 8);
    expectEq(fp5FromBytes(backing.subarray(8, 48)), FP5_TWO, 'offset decode');
    expectEq(fp5FromBytesStrict(backing.subarray(8, 48)), FP5_TWO, 'offset strict decode');
  });

  test('encoder always emits 40 bytes, coefficient 0 first', () => {
    const bytes = fp5ToBytes(fp5FromLimbs([1n, 2n, 3n, 4n, 5n]));
    expect(bytes.length).toBe(40);
    expect(hex(bytes)).toBe(
      '01000000000000000200000000000000030000000000000004000000000000000500000000000000',
    );
  });

  test('fp5FromLimbs checks arity and reduces Euclidean-style', () => {
    expect(() => fp5FromLimbs([1n, 2n, 3n, 4n])).toThrow();
    expect(() => fp5FromLimbs([1n, 2n, 3n, 4n, 5n, 6n])).toThrow();
    expect(raw(fp5FromLimbs([-1n, 0n, 0n, 0n, 0n])[0])).toBe(P - 1n);
  });

  test('fp5FromU64 reduces rather than truncating, and rejects out-of-domain input', () => {
    expect(raw(fp5FromU64(0xffffffffffffffffn)[0])).toBe(4294967294n);
    expect(() => fp5FromU64(-1n)).toThrow();
    expect(() => fp5FromU64(1n << 64n)).toThrow();
  });

  test('fp5FromFp embeds into coefficient 0', () => {
    expectEq(fp5FromFp(7n as Fp), fp5FromLimbs([7n, 0n, 0n, 0n, 0n]), 'fromFp');
  });
});

describe('guards', () => {
  const a = fp5FromLimbs([1n, 2n, 3n, 4n, 5n]);

  test('repeatedFrobenius rejects non-positive counts', () => {
    // The reference lets a negative count through and the loop never runs, silently returning the
    // input — a Frobenius that is quietly the identity.
    expect(() => fp5RepeatedFrobenius(a, 0)).toThrow();
    expect(() => fp5RepeatedFrobenius(a, -1)).toThrow();
    expect(() => fp5RepeatedFrobenius(a, -5)).toThrow();
    expect(() => fp5RepeatedFrobenius(a, 1.5)).toThrow();
    expect(() => fp5RepeatedFrobenius(a, Number.NaN)).toThrow();
  });

  test('repeatedFrobenius(a, 5k) is the identity, and phi^5 === id', () => {
    expectEq(fp5RepeatedFrobenius(a, 5), a, 'n = 5');
    expectEq(fp5RepeatedFrobenius(a, 10), a, 'n = 10');
    expectEq(fp5RepeatedFrobenius(a, 7), fp5RepeatedFrobenius(a, 2), 'n = 7 === n = 2');
  });

  test('expPow2 rejects a negative or fractional count', () => {
    expect(() => fp5ExpPow2(a, -1)).toThrow();
    expect(() => fp5ExpPow2(a, 0.5)).toThrow();
    expectEq(fp5ExpPow2(a, 0), a, 'zero squarings');
    expectEq(fp5ExpPow2(a, 1), fp5Square(a), 'one squaring');
    expectEq(fp5ExpPow2(a, 3), fp5Square(fp5Square(fp5Square(a))), 'three squarings');
  });

  test('inverse and div throw on zero; inverseOrZero does not', () => {
    expect(() => fp5Inverse(FP5_ZERO)).toThrow();
    expect(() => fp5Div(FP5_ONE, FP5_ZERO)).toThrow();
    expect(fp5InverseOrZero(FP5_ZERO)).toEqual(FP5_ZERO);
    expectEq(fp5Inverse(FP5_TWO), fp5InverseOrZero(FP5_TWO), 'agree off zero');
  });

  test('constants', () => {
    expect(FP5_ZERO.map(String)).toEqual(['0', '0', '0', '0', '0']);
    expect(FP5_ONE.map(String)).toEqual(['1', '0', '0', '0', '0']);
    expect(FP5_TWO.map(String)).toEqual(['2', '0', '0', '0', '0']);
    expect(fp5IsZero(FP5_ZERO)).toBe(true);
    expect(fp5IsZero(FP5_ONE)).toBe(false);
    expect(fp5Equals(FP5_ONE, FP5_ONE)).toBe(true);
    expect(fp5Equals(FP5_ONE, FP5_TWO)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Properties over 10^4 seeded pseudo-random elements
// ---------------------------------------------------------------------------------------------

describe('properties over 10^4 seeded elements', () => {
  const N = 10_000;
  const xs = randomElements(0x1234_5678_9abc_def0n, N);
  const ys = randomElements(0x0fed_cba9_8765_4321n, N);

  test('the corpus is what it claims to be', () => {
    expect(xs.length).toBe(N);
    expect(new Set(xs.map((x) => x.join(','))).size).toBe(N);
  });

  test('mul agrees with the naive schoolbook model', () => {
    for (let i = 0; i < N; i += 1) {
      const x = xs[i];
      const y = ys[i];
      if (x === undefined || y === undefined) throw new Error('short corpus');
      const fast = fp5Mul(x, y);
      const slow = naiveMul(x, y);
      if (fast.some((c, k) => c !== slow[k])) {
        throw new Error(`mul mismatch at ${i}\n  ${fast.join(',')}\n  ${slow.join(',')}`);
      }
      // square is a separate code path with merged cross terms; hold it to the same model.
      const sq = fp5Square(x);
      const sqSlow = naiveMul(x, x);
      if (sq.some((c, k) => c !== sqSlow[k])) {
        throw new Error(`square mismatch at ${i}`);
      }
    }
  });

  test('frobenius^5 is the identity and frobenius is multiplicative', () => {
    for (let i = 0; i < N; i += 1) {
      const x = xs[i];
      const y = ys[i];
      if (x === undefined || y === undefined) throw new Error('short corpus');
      if (!fp5Equals(fp5RepeatedFrobenius(x, 5), x)) throw new Error(`phi^5 !== id at ${i}`);
      if (!fp5Equals(fp5Frobenius(fp5Mul(x, y)), fp5Mul(fp5Frobenius(x), fp5Frobenius(y)))) {
        throw new Error(`phi not multiplicative at ${i}`);
      }
    }
  });

  test('norm lands in the base field and is multiplicative', () => {
    for (let i = 0; i < N; i += 1) {
      const x = xs[i];
      const y = ys[i];
      if (x === undefined || y === undefined) throw new Error('short corpus');
      const n = fp5Norm(x);
      if (typeof n !== 'bigint' || n < 0n || n >= P) throw new Error(`norm out of range at ${i}`);
      if (n === 0n) throw new Error(`norm of a non-zero element is zero at ${i}`);
      if (fp5Norm(fp5Mul(x, y)) !== (fp5Norm(x) * fp5Norm(y)) % P) {
        throw new Error(`norm not multiplicative at ${i}`);
      }
    }
  });

  test('x · inverseOrZero(x) === 1 for every non-zero x', () => {
    for (let i = 0; i < N; i += 1) {
      const x = xs[i];
      if (x === undefined) throw new Error('short corpus');
      if (fp5IsZero(x)) continue;
      if (!fp5Equals(fp5Mul(x, fp5InverseOrZero(x)), FP5_ONE)) {
        throw new Error(`inverse failed at ${i}`);
      }
    }
  });

  test('legendre(square(x)) === 1 for every non-zero x', () => {
    for (let i = 0; i < N; i += 1) {
      const x = xs[i];
      if (x === undefined) throw new Error('short corpus');
      if (fp5IsZero(x)) continue;
      if (fp5Legendre(fp5Square(x)) !== 1n) throw new Error(`legendre(x^2) !== 1 at ${i}`);
    }
  });

  test('sqrt(x)^2 === x whenever it exists, and never exists for a non-square', () => {
    let squares = 0;
    for (let i = 0; i < N; i += 1) {
      const x = xs[i];
      if (x === undefined) throw new Error('short corpus');
      const { root, exists } = fp5Sqrt(x);
      const legendre = fp5Legendre(x);
      if (exists !== (legendre === 0n || legendre === 1n)) {
        throw new Error(`sqrt/legendre disagree at ${i}`);
      }
      if (!exists) {
        if (!fp5IsZero(root)) throw new Error(`non-square returned a root at ${i}`);
        continue;
      }
      squares += 1;
      if (!fp5Equals(fp5Square(root), x)) throw new Error(`sqrt(x)^2 !== x at ${i}`);
      const canonical = fp5CanonicalSqrt(x);
      if (!fp5Equals(fp5Square(canonical.root), x)) throw new Error(`canonicalSqrt^2 !== x at ${i}`);
      if (fp5Sgn0(canonical.root) && canonical.root[0] !== 0n) {
        throw new Error(`canonicalSqrt returned an even, non-zero coefficient 0 at ${i}`);
      }
    }
    // Roughly half of a random corpus should be square; a degenerate implementation would skew.
    expect(squares).toBeGreaterThan(N / 4);
    expect(squares).toBeLessThan((3 * N) / 4);
  });

  test('field axioms: distributivity, and sub/neg/double/triple/scalarMul consistency', () => {
    for (let i = 0; i < N; i += 1) {
      const x = xs[i];
      const y = ys[i];
      if (x === undefined || y === undefined) throw new Error('short corpus');
      if (!fp5Equals(fp5Mul(x, fp5Add(y, FP5_ONE)), fp5Add(fp5Mul(x, y), x))) {
        throw new Error(`distributivity failed at ${i}`);
      }
      if (!fp5Equals(fp5Sub(x, y), fp5Add(x, fp5Neg(y)))) throw new Error(`sub !== add(neg) at ${i}`);
      if (!fp5Equals(fp5Double(x), fp5Add(x, x))) throw new Error(`double at ${i}`);
      if (!fp5Equals(fp5Triple(x), fp5Add(fp5Double(x), x))) throw new Error(`triple at ${i}`);
      if (!fp5Equals(fp5ScalarMul(x, y[0]), fp5Mul(x, fp5FromFp(y[0])))) {
        throw new Error(`scalarMul at ${i}`);
      }
    }
  });

  test('the 40-byte codec round-trips', () => {
    for (let i = 0; i < N; i += 1) {
      const x = xs[i];
      if (x === undefined) throw new Error('short corpus');
      const bytes = fp5ToBytes(x);
      if (bytes.length !== 40) throw new Error(`bad length at ${i}`);
      if (!fp5Equals(fp5FromBytes(bytes), x)) throw new Error(`round-trip at ${i}`);
      if (!fp5Equals(fp5FromBytesStrict(bytes), x)) throw new Error(`strict round-trip at ${i}`);
    }
  });
});
