/**
 * `GF(p)` is the bottom of the crypto stack: `GF(p^5)`, Poseidon2, ECgFp5 and Schnorr are all built
 * out of this module, and a single wrong bit here produces a signature the sequencer rejects with no
 * useful error anywhere in the stack. So the coverage here is deliberately redundant.
 *
 * Four layers:
 *
 * 1. **Vectors** — all 118 `cases` rows, all 14 `encoding` rows, and the 3 `nonCanonicalNotes`
 *    examples from `conformance/vectors/goldilocks.json`, which are generated from the Go reference.
 * 2. **Canonicality** — the reference's stored `uint64` may sit one `p` above the true residue. The
 *    three examples pin exactly where that diverges, and this module must produce `canonical` and
 *    never `raw`.
 * 3. **Properties** — 10^4 seeded pseudo-random inputs per law, for the five functions the oracle
 *    emits no rows for (`reduce128`, `reduceWide`, `fpMulAcc`, `fpInverse`, `fpBatchInverse`).
 * 4. **Goldens and traps** — hand-checkable values, and the specific mistakes this module exists to
 *    prevent: sign-following `%`, truncation mistaken for reduction, and the wrong square root.
 */

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  EPSILON,
  P,
  POWER_OF_TWO_GENERATOR,
  TWO_ADICITY,
} from '../../../src/crypto/field/constants.js';
import {
  FP_NEG_ONE,
  FP_ONE,
  FP_TWO,
  FP_ZERO,
  fpAdd,
  fpArrayFromBytes,
  fpArrayToBytes,
  fpBatchInverse,
  fpDouble,
  fpExp,
  fpExpPow2,
  fpFromBytes,
  fpFromBytesUnchecked,
  fpFromInt,
  fpFromU64,
  fpInverse,
  fpInverseOrZero,
  fpIsQuadraticResidue,
  fpMul,
  fpMulAcc,
  fpNeg,
  fpPowers,
  fpSquare,
  fpSqrt,
  fpSub,
  fpToBytes,
  reduce128,
  reduceWide,
  type Fp,
} from '../../../src/crypto/field/fp.js';

interface Case {
  readonly a: string;
  readonly b: string;
  readonly add: string;
  readonly sub: string;
  readonly mul: string;
  readonly squareA: string;
  readonly doubleA: string;
  readonly negA: string;
  readonly exp: string;
  readonly expPow2: string;
  readonly isQuadraticResidueA: boolean;
  readonly sqrtA: string | null;
}

interface NonCanonicalExample {
  readonly op: string;
  readonly a: string;
  readonly b: string;
  readonly raw: string;
  readonly canonical: string;
  readonly leBytesHex: string;
}

const vectorsUrl = new URL('../../../conformance/vectors/goldilocks.json', import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, 'utf8')) as {
  order: string;
  epsilon: string;
  twoAdicity: number;
  powerOfTwoGenerator: string;
  cases: readonly Case[];
  encoding: readonly { readonly value: string; readonly leBytesHex: string }[];
  nonCanonicalNotes: { readonly examples: readonly NonCanonicalExample[] };
};

const fpSource = await readFile(
  new URL('../../../src/crypto/field/fp.ts', import.meta.url),
  'utf8',
);

/** Lift a canonical literal into the branded type. */
const fp = (v: bigint): Fp => fpFromInt(v);

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const unhex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/**
 * splitmix64 — the same generator the oracle seeds its inputs with. Deterministic, so a property
 * failure is reproducible rather than a flake.
 */
function rng(seed: bigint): () => bigint {
  const mask = (1n << 64n) - 1n;
  let s = seed & mask;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & mask;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask;
    return (z ^ (z >> 31n)) & mask;
  };
}

const ITERATIONS = 10_000;

describe('goldilocks.json — header constants', () => {
  test('order, epsilon, twoAdicity, powerOfTwoGenerator', () => {
    expect(P).toBe(BigInt(vectors.order));
    expect(EPSILON).toBe(BigInt(vectors.epsilon));
    expect<number>(TWO_ADICITY).toBe(vectors.twoAdicity);
    expect(POWER_OF_TWO_GENERATOR).toBe(BigInt(vectors.powerOfTwoGenerator));
  });
});

describe('goldilocks.json — all 118 arithmetic cases', () => {
  test('the vector file still carries the full case set', () => {
    expect(vectors.cases.length).toBe(118);
  });

  test('add, sub, mul, square, double, neg', () => {
    for (const [i, c] of vectors.cases.entries()) {
      const a = fp(BigInt(c.a));
      const b = fp(BigInt(c.b));
      expect<[number, bigint]>([i, fpAdd(a, b)]).toEqual([i, BigInt(c.add)]);
      expect<[number, bigint]>([i, fpSub(a, b)]).toEqual([i, BigInt(c.sub)]);
      expect<[number, bigint]>([i, fpMul(a, b)]).toEqual([i, BigInt(c.mul)]);
      expect<[number, bigint]>([i, fpSquare(a)]).toEqual([i, BigInt(c.squareA)]);
      expect<[number, bigint]>([i, fpDouble(a)]).toEqual([i, BigInt(c.doubleA)]);
      expect<[number, bigint]>([i, fpNeg(a)]).toEqual([i, BigInt(c.negA)]);
    }
  });

  test('exp is a^b with the row b as exponent; expPow2 is 7 repeated squarings', () => {
    for (const [i, c] of vectors.cases.entries()) {
      const a = fp(BigInt(c.a));
      expect<[number, bigint]>([i, fpExp(a, BigInt(c.b))]).toEqual([i, BigInt(c.exp)]);
      expect<[number, bigint]>([i, fpExpPow2(a, 7)]).toEqual([i, BigInt(c.expPow2)]);
      // expPow2 is a^(2^7) — the same thing said the other way.
      expect<[number, bigint]>([i, fpExp(a, 2n ** 7n)]).toEqual([i, BigInt(c.expPow2)]);
    }
  });

  test('isQuadraticResidue and sqrt', () => {
    let nonResidues = 0;
    for (const [i, c] of vectors.cases.entries()) {
      const a = fp(BigInt(c.a));
      expect<[number, boolean]>([i, fpIsQuadraticResidue(a)]).toEqual([i, c.isQuadraticResidueA]);
      const root = fpSqrt(a);
      if (c.sqrtA === null) {
        nonResidues += 1;
        expect<[number, Fp | null]>([i, root]).toEqual([i, null]);
        expect<[number, boolean]>([i, c.isQuadraticResidueA]).toEqual([i, false]);
      } else {
        expect(root).not.toBeNull();
        expect<[number, bigint]>([i, root as Fp]).toEqual([i, BigInt(c.sqrtA)]);
        expect<[number, bigint]>([i, fpSquare(root as Fp)]).toEqual([i, BigInt(c.a)]);
      }
    }
    // sqrt is null on exactly the rows where the Legendre symbol says non-residue.
    expect(nonResidues).toBe(37);
  });

  test('every produced value is canonical', () => {
    for (const c of vectors.cases) {
      const a = fp(BigInt(c.a));
      const b = fp(BigInt(c.b));
      for (const v of [fpAdd(a, b), fpSub(a, b), fpMul(a, b), fpNeg(a), fpDouble(a)]) {
        expect(v >= 0n && v < P).toBe(true);
      }
    }
  });
});

describe('goldilocks.json — 14 encoding rows', () => {
  test('fpToBytes produces leBytesHex and fpFromBytes round-trips', () => {
    expect(vectors.encoding.length).toBe(14);
    for (const row of vectors.encoding) {
      const v = fp(BigInt(row.value));
      expect(hex(fpToBytes(v))).toBe(row.leBytesHex);
      expect(fpFromBytes(unhex(row.leBytesHex))).toBe(v);
      expect(fpFromBytesUnchecked(unhex(row.leBytesHex))).toBe(v);
    }
  });

  test('array encoding is the concatenation of the element encodings', () => {
    const values = vectors.encoding.map((r) => fp(BigInt(r.value)));
    const bytes = fpArrayToBytes(values);
    expect(bytes.length).toBe(values.length * 8);
    expect(hex(bytes)).toBe(vectors.encoding.map((r) => r.leBytesHex).join(''));
    expect(fpArrayFromBytes(bytes)).toEqual(values);
  });
});

describe('goldilocks.json — nonCanonicalNotes: canonical, never raw', () => {
  test('all 3 examples produce the canonical residue', () => {
    const examples = vectors.nonCanonicalNotes.examples;
    expect(examples.length).toBe(3);
    for (const e of examples) {
      const a = fp(BigInt(e.a));
      const b = fp(BigInt(e.b));
      const got = e.op === 'add' ? fpAdd(a, b) : fpMul(a, b);
      expect(got).toBe(fp(BigInt(e.canonical)));
      expect(got).not.toBe(BigInt(e.raw) as unknown as Fp);
      expect(hex(fpToBytes(got))).toBe(e.leBytesHex);
    }
  });

  test('the two named divergences, spelled out', () => {
    // The reference stores 18446744069414584321 here; we must produce 0.
    expect(fpAdd(FP_NEG_ONE, FP_ONE)).toBe(FP_ZERO);
    // The reference stores 18446744069414584322 here; we must produce 1.
    expect(fpMul(FP_NEG_ONE, FP_NEG_ONE)).toBe(FP_ONE);
    expect(fpAdd(FP_NEG_ONE, FP_TWO)).toBe(FP_ONE);
  });
});

describe('base-field goldens — hand-checkable values', () => {
  test('identities', () => {
    expect(FP_ZERO).toBe(0n as unknown as Fp);
    expect(FP_ONE).toBe(1n as unknown as Fp);
    expect(FP_TWO).toBe(2n as unknown as Fp);
    expect(FP_NEG_ONE).toBe(18446744069414584320n as unknown as Fp);
    expect(fpNeg(FP_ONE)).toBe(FP_NEG_ONE);
    expect(fpNeg(FP_ZERO)).toBe(FP_ZERO);
  });

  test('truncation is not reduction: 2^64 - 1 reduces to 2^32 - 2', () => {
    expect(fpFromU64(2n ** 64n - 1n)).toBe(4294967294n as unknown as Fp);
    expect(fpFromU64(2n ** 64n - 1n)).not.toBe(FP_NEG_ONE);
    expect(fpFromU64(P)).toBe(FP_ZERO);
    expect(fpFromU64(P - 1n)).toBe(FP_NEG_ONE);
    expect(fpFromU64(0n)).toBe(FP_ZERO);
  });

  test('% follows the sign of the dividend, so fpFromInt fixes up', () => {
    expect((-1n) % P).toBe(-1n); // the trap itself
    expect(fpFromInt(-1n)).toBe(FP_NEG_ONE);
    expect(fpFromInt(-P)).toBe(FP_ZERO);
    expect(fpFromInt(-P - 1n)).toBe(FP_NEG_ONE);
    expect(fpFromInt(P + 5n)).toBe(fp(5n));
    expect(fpFromInt(-(2n ** 200n))).toBe(fp(((-(2n ** 200n) % P) + P) % P));
    expect(fpSub(FP_ZERO, FP_ONE)).toBe(FP_NEG_ONE);
  });

  test('arithmetic goldens', () => {
    expect(fpDouble(FP_NEG_ONE)).toBe(fp(P - 2n));
    expect(fpMul(fp(EPSILON), fp(EPSILON))).toBe(fp(18446744065119617025n));
    expect(fpExp(fp(7n), 12n)).toBe(fp(13841287201n)); // 7^12 < p, so it is exact
    expect(fpExp(fp(7n), 0n)).toBe(FP_ONE);
    expect(fpExp(FP_ZERO, 0n)).toBe(FP_ONE);
    expect(fpExp(FP_ZERO, 5n)).toBe(FP_ZERO);
    expect(fpExpPow2(FP_TWO, 6)).toBe(fp(2n ** 64n % P));
    expect(fpExpPow2(fp(5n), 0)).toBe(fp(5n));
    expect(fpMulAcc(fp(10n), fp(3n), fp(4n))).toBe(fp(22n));
  });

  test('inverse goldens', () => {
    expect(fpInverse(FP_TWO)).toBe(fp(9223372034707292161n)); // (p+1)/2
    expect(fpMul(fpInverse(FP_TWO), FP_TWO)).toBe(FP_ONE);
    expect(fpInverse(fp(3n))).toBe(fp(12297829379609722881n));
    expect(fpInverse(FP_ONE)).toBe(FP_ONE);
    expect(fpInverse(FP_NEG_ONE)).toBe(FP_NEG_ONE);
  });

  test('sqrt goldens — the branch the plonky2 generator picks', () => {
    expect(fpSqrt(FP_ZERO)).toBe(FP_ZERO);
    expect(fpIsQuadraticResidue(FP_ZERO)).toBe(true);
    expect(fpSqrt(FP_ONE)).toBe(FP_ONE);
    // sqrt(4) is p-2, i.e. -2, not 2 — which root comes back is exactly what
    // POWER_OF_TWO_GENERATOR decides, and it propagates into curve decompression.
    expect(fpSqrt(fp(4n))).toBe(fp(P - 2n));
    expect(fpSqrt(FP_TWO)).toBe(fp(1099494850304n));
    expect(fpSqrt(fp(3n))).toBe(fp(18446462594438004737n));
    // 7 is a non-residue.
    expect(fpIsQuadraticResidue(fp(7n))).toBe(false);
    expect(fpSqrt(fp(7n))).toBeNull();
  });

  test('reduction goldens', () => {
    expect(reduce128(2n ** 127n)).toBe(fp(18446744067267100673n));
    expect(reduce128((P - 1n) * (P - 1n))).toBe(FP_ONE);
    expect(reduceWide(2n ** 191n - 1n)).toBe(fp(9223372034707292160n));
    expect(reduce128(0n)).toBe(FP_ZERO);
  });

  test('fpPowers', () => {
    expect(fpPowers(fp(3n), 5)).toEqual([fp(1n), fp(3n), fp(9n), fp(27n), fp(81n)]);
    expect(fpPowers(fp(3n), 0)).toEqual([]);
    expect(fpPowers(fp(3n), 1)).toEqual([FP_ONE]);
    expect(fpPowers(FP_NEG_ONE, 4)).toEqual([FP_ONE, FP_NEG_ONE, FP_ONE, FP_NEG_ONE]);
  });
});

describe('errors', () => {
  test('fpExp rejects a negative exponent rather than implying an inverse', () => {
    expect(() => fpExp(FP_TWO, -1n)).toThrow();
    try {
      fpExp(FP_TWO, -1n);
    } catch (e) {
      expect((e as { kind: string }).kind).toBe('math');
    }
  });

  test('fpInverse(0) throws; fpInverseOrZero(0) is 0', () => {
    expect(() => fpInverse(FP_ZERO)).toThrow();
    try {
      fpInverse(FP_ZERO);
    } catch (e) {
      expect((e as { kind: string }).kind).toBe('math');
    }
    expect(fpInverseOrZero(FP_ZERO)).toBe(FP_ZERO);
  });

  test('fpExpPow2 rejects a negative count', () => {
    expect(() => fpExpPow2(FP_TWO, -1)).toThrow();
  });

  test('fpFromBytes is strict about length and canonicality', () => {
    expect(() => fpFromBytes(new Uint8Array(7))).toThrow();
    expect(() => fpFromBytes(new Uint8Array(9))).toThrow();
    // p itself, little-endian: the first non-canonical word.
    const pBytes = unhex('01000000ffffffff');
    expect(() => fpFromBytes(pBytes)).toThrow();
    try {
      fpFromBytes(pBytes);
    } catch (e) {
      expect((e as { kind: string }).kind).toBe('decode');
    }
    // 2^64 - 1, the largest non-canonical word.
    expect(() => fpFromBytes(unhex('ffffffffffffffff'))).toThrow();
  });

  test('fpFromBytesUnchecked reduces the same words instead', () => {
    expect(fpFromBytesUnchecked(unhex('01000000ffffffff'))).toBe(FP_ZERO);
    expect(fpFromBytesUnchecked(unhex('ffffffffffffffff'))).toBe(fp(4294967294n));
    expect(() => fpFromBytesUnchecked(new Uint8Array(4))).toThrow();
  });

  test('fpArrayFromBytes errors on a non-canonical group — the auth-token packer depends on it', () => {
    expect(() => fpArrayFromBytes(unhex('0100000000000000' + '01000000ffffffff'))).toThrow();
    try {
      fpArrayFromBytes(unhex('01000000ffffffff'));
    } catch (e) {
      expect((e as { kind: string }).kind).toBe('decode');
    }
  });

  test('fpFromU64 rejects anything outside [0, 2^64)', () => {
    expect(() => fpFromU64(-1n)).toThrow();
    expect(() => fpFromU64(2n ** 64n)).toThrow();
  });
});

describe('fpArrayFromBytes — grouping and padding', () => {
  test('splits into 8-byte little-endian groups', () => {
    expect(fpArrayFromBytes(new Uint8Array(0))).toEqual([]);
    expect(fpArrayFromBytes(unhex('0100000000000000' + '0200000000000000'))).toEqual([
      FP_ONE,
      FP_TWO,
    ]);
  });

  test('a short final group is right-padded with zeros', () => {
    // "abc" -> 0x636261 little-endian.
    expect(fpArrayFromBytes(new Uint8Array([0x61, 0x62, 0x63]))).toEqual([fp(0x636261n)]);
    expect(fpArrayFromBytes(unhex('0100000000000000' + 'ff'))).toEqual([FP_ONE, fp(0xffn)]);
  });

  test('packs an auth-token style message, which never approaches p', () => {
    const message = '1700000000:12345:0';
    const bytes = new TextEncoder().encode(message);
    const elements = fpArrayFromBytes(bytes);
    expect(elements.length).toBe(Math.ceil(bytes.length / 8));
    for (const e of elements) expect(e < P).toBe(true);
  });

  test('round-trips a whole-multiple-of-8 buffer through fpArrayToBytes', () => {
    const values = [fp(1n), fp(P - 1n), fp(0n), fp(1234567890123n)];
    expect(fpArrayFromBytes(fpArrayToBytes(values))).toEqual(values);
  });

  test('decoders accept a subarray view, not just a whole buffer', () => {
    const backing = new Uint8Array(16);
    backing.set(fpToBytes(fp(42n)), 8);
    expect(fpFromBytes(backing.subarray(8, 16))).toBe(fp(42n));
    expect(fpFromBytesUnchecked(backing.subarray(8, 16))).toBe(fp(42n));
  });
});

describe('properties over 10^4 seeded pseudo-random inputs', () => {
  test('reduce128(x) === x % P for x < 2^128', () => {
    const next = rng(0x1234_5678_9abc_def0n);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const x = (next() << 64n) | next();
      expect(x < 2n ** 128n).toBe(true);
      expect(reduce128(x)).toBe(fp(x % P));
    }
  });

  test('reduceWide(x) === x % P for x < 2^192', () => {
    const next = rng(0x0fed_cba9_8765_4321n);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const x = (next() << 128n) | (next() << 64n) | next();
      expect(x < 2n ** 192n).toBe(true);
      expect(reduceWide(x)).toBe(fp(x % P));
    }
  });

  test('fpMulAcc(s, x, y) === fpAdd(s, fpMul(x, y))', () => {
    const next = rng(0xdead_beef_cafe_baben);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const s = fp(next());
      const x = fp(next());
      const y = fp(next());
      expect(fpMulAcc(s, x, y)).toBe(fpAdd(s, fpMul(x, y)));
    }
  });

  test('fpMul(a, fpInverseOrZero(a)) === 1 for a != 0, and the chain equals a^(p-2)', () => {
    const next = rng(0x00c0_ffee_0000_0001n);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const a = fp(next());
      if (a === FP_ZERO) {
        expect(fpInverseOrZero(a)).toBe(FP_ZERO);
        continue;
      }
      const inv = fpInverseOrZero(a);
      expect(fpMul(a, inv)).toBe(FP_ONE);
      expect(inv).toBe(fpInverse(a));
    }
  });

  test('the addition chain agrees with a^(p-2) by square-and-multiply', () => {
    const next = rng(0x5eed_0000_0000_0007n);
    for (let i = 0; i < 1_000; i += 1) {
      const a = fp(next() | 1n);
      expect(fpInverseOrZero(a)).toBe(fpExp(a, P - 2n));
    }
  });

  test('fpBatchInverse agrees element-wise with fpInverseOrZero', () => {
    const next = rng(0x0bad_c0de_0000_0002n);
    let total = 0;
    while (total < ITERATIONS) {
      const n = Number(next() % 17n);
      const xs: Fp[] = [];
      for (let i = 0; i < n; i += 1) {
        // Deliberately salt in zeros: batch inversion must tolerate them.
        xs.push(next() % 11n === 0n ? FP_ZERO : fp(next()));
      }
      const batch = fpBatchInverse(xs);
      expect(batch.length).toBe(xs.length);
      for (let i = 0; i < n; i += 1) {
        expect(batch[i]).toBe(fpInverseOrZero(xs[i] as Fp));
      }
      total += n + 1;
    }
  });

  test('field laws: commutativity, distributivity, sub/neg agreement, square = mul', () => {
    const next = rng(0xa5a5_a5a5_5a5a_5a5an);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const a = fp(next());
      const b = fp(next());
      const c = fp(next());
      expect(fpAdd(a, b)).toBe(fpAdd(b, a));
      expect(fpMul(a, b)).toBe(fpMul(b, a));
      expect(fpMul(a, fpAdd(b, c))).toBe(fpAdd(fpMul(a, b), fpMul(a, c)));
      expect(fpSub(a, b)).toBe(fpAdd(a, fpNeg(b)));
      expect(fpSquare(a)).toBe(fpMul(a, a));
      expect(fpDouble(a)).toBe(fpAdd(a, a));
      expect(fpAdd(a, fpNeg(a))).toBe(FP_ZERO);
      // Everything stays canonical.
      for (const v of [fpAdd(a, b), fpSub(a, b), fpMul(a, b), fpNeg(a), fpDouble(a)]) {
        expect(v >= 0n && v < P).toBe(true);
      }
    }
  });

  test('sqrt and the Legendre symbol agree, and roots square back', () => {
    const next = rng(0x1111_2222_3333_4444n);
    let residues = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const a = fp(next());
      const isQr = fpIsQuadraticResidue(a);
      const root = fpSqrt(a);
      if (isQr) {
        residues += 1;
        expect(root).not.toBeNull();
        expect(fpSquare(root as Fp)).toBe(a);
      } else {
        expect(root).toBeNull();
      }
      // A square always has a root.
      expect(fpIsQuadraticResidue(fpSquare(a))).toBe(true);
      expect(fpSquare(fpSqrt(fpSquare(a)) as Fp)).toBe(fpSquare(a));
    }
    // Roughly half of all elements are squares; a broken predicate skews this badly.
    expect(residues).toBeGreaterThan(ITERATIONS / 3);
    expect(residues).toBeLessThan((ITERATIONS * 2) / 3);
  });

  test('byte codec round-trips', () => {
    const next = rng(0x9999_8888_7777_6666n);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const a = fp(next());
      const bytes = fpToBytes(a);
      expect(bytes.length).toBe(8);
      expect(fpFromBytes(bytes)).toBe(a);
      expect(fpFromBytesUnchecked(bytes)).toBe(a);
    }
  });

  test('fpFromU64 reduces every 64-bit word by a single exact subtraction', () => {
    const next = rng(0x4444_3333_2222_1111n);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const w = next();
      expect(fpFromU64(w)).toBe(fp(w % P));
    }
  });
});

describe('module hygiene', () => {
  test('reduce128 and reduceWide are a single % — no hi/lo split, no fixup chain', () => {
    expect(/export function reduce128\(x: bigint\): Fp \{\n\s*return \(x % P\) as Fp;\n\}/.test(fpSource)).toBe(
      true,
    );
    expect(/export function reduceWide\(x: bigint\): Fp \{\n\s*return \(x % P\) as Fp;\n\}/.test(fpSource)).toBe(
      true,
    );
    // EPSILON is the fold factor a hand-rolled Goldilocks reduction needs; this module never folds.
    expect(fpSource.includes('EPSILON')).toBe(false);
  });

  test('no platform coupling', () => {
    expect(/from ['"]node:/.test(fpSource)).toBe(false);
    expect(/\bBuffer\b/.test(fpSource)).toBe(false);
    expect(/\bprocess\./.test(fpSource)).toBe(false);
    expect(fpSource.includes('require(')).toBe(false);
  });

  test('fp.ts imports only ./constants.js and ../../errors.js', () => {
    const pattern = /from ['"]([^'"]+)['"]/g;
    const specifiers: string[] = [];
    for (;;) {
      const match: RegExpExecArray | null = pattern.exec(fpSource);
      if (match === null) break;
      specifiers.push(match[1] as string);
    }
    expect(specifiers.sort()).toEqual(['../../errors.js', './constants.js']);
  });
});
