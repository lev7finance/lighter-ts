/**
 * The field constants are data, and a transcribed digit is the one kind of error that produces a
 * plausible-looking value with no traceable failure. So nothing here trusts the literals: each
 * constant is re-derived from a defining property or compared against
 * `conformance/vectors/goldilocks.json`.
 *
 * The Frobenius tables get the strongest treatment, because `fp5.ts` is owned by another unit that
 * cannot edit `constants.ts` — if a table is wrong, its square roots and every curve decompression
 * downstream are wrong.
 */

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  EPSILON,
  FP5_DTH_ROOT,
  FP5_W,
  FROB1,
  FROB2,
  FROB3,
  FROB4,
  MASK32,
  MASK64,
  MULTIPLICATIVE_GENERATOR,
  P,
  POWER_OF_TWO_GENERATOR,
  TWO_ADICITY,
} from '../../../src/crypto/field/constants.js';

const vectorsUrl = new URL('../../../conformance/vectors/goldilocks.json', import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, 'utf8')) as {
  order: string;
  epsilon: string;
  twoAdicity: number;
  powerOfTwoGenerator: string;
};

/** Modular exponentiation written independently of `fp.ts`, so the tables are checked, not echoed. */
function powMod(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

describe('constants — the modulus and its derived quantities', () => {
  test('P matches the vectors and its closed form', () => {
    expect(P).toBe(BigInt(vectors.order));
    expect(P).toBe(2n ** 64n - 2n ** 32n + 1n);
    expect(P).toBe(18446744069414584321n);
  });

  test('EPSILON is 2^64 mod p', () => {
    expect(EPSILON).toBe(BigInt(vectors.epsilon));
    expect(EPSILON).toBe(2n ** 64n % P);
    expect(EPSILON).toBe(2n ** 32n - 1n);
  });

  test('the masks are 32 and 64 bits of ones', () => {
    expect(MASK32).toBe(2n ** 32n - 1n);
    expect(MASK64).toBe(2n ** 64n - 1n);
  });

  test('TWO_ADICITY is exactly 32 — 2^32 divides p-1 and 2^33 does not', () => {
    expect<number>(TWO_ADICITY).toBe(vectors.twoAdicity);
    expect((P - 1n) % 2n ** 32n).toBe(0n);
    expect((P - 1n) % 2n ** 33n).not.toBe(0n);
  });

  test('MULTIPLICATIVE_GENERATOR generates the whole group', () => {
    expect(MULTIPLICATIVE_GENERATOR).toBe(7n);
    // p - 1 = 2^32 * 3 * 5 * 17 * 257 * 65537. A generator is a non-residue for every prime factor.
    for (const q of [2n, 3n, 5n, 17n, 257n, 65537n]) {
      expect((P - 1n) % q).toBe(0n);
      expect(powMod(MULTIPLICATIVE_GENERATOR, (P - 1n) / q, P)).not.toBe(1n);
    }
  });
});

describe('constants — POWER_OF_TWO_GENERATOR is the plonky2 literal, not the derived one', () => {
  test('matches the vectors', () => {
    expect(POWER_OF_TWO_GENERATOR).toBe(BigInt(vectors.powerOfTwoGenerator));
    expect(POWER_OF_TWO_GENERATOR).toBe(7277203076849721926n);
  });

  test('it generates the order-2^32 subgroup', () => {
    expect(powMod(POWER_OF_TWO_GENERATOR, 2n ** 32n, P)).toBe(1n);
    expect(powMod(POWER_OF_TWO_GENERATOR, 2n ** 31n, P)).not.toBe(1n);
  });

  test('it is NOT 7^((p-1)/2^32), which is the value people substitute', () => {
    const derived = powMod(MULTIPLICATIVE_GENERATOR, (P - 1n) / 2n ** 32n, P);
    expect(derived).toBe(1753635133440165772n);
    expect(POWER_OF_TWO_GENERATOR).not.toBe(derived);
    // Both are valid generators of the same subgroup; only one picks the roots the protocol expects.
    expect(powMod(derived, 2n ** 32n, P)).toBe(1n);
  });
});

describe('constants — GF(p^5) parameters', () => {
  test('FP5_W is 3: the extension is GF(p)[X]/(X^5 - 3)', () => {
    expect(FP5_W).toBe(3n);
    // X^5 - 3 is irreducible only if 3 is not a fifth power, i.e. 3^((p-1)/5) != 1.
    expect(powMod(FP5_W, (P - 1n) / 5n, P)).not.toBe(1n);
  });

  test('FP5_DTH_ROOT is 3^((p-1)/5), a primitive fifth root of unity', () => {
    expect(FP5_DTH_ROOT).toBe(powMod(3n, (P - 1n) / 5n, P));
    expect(FP5_DTH_ROOT).toBe(1041288259238279555n);
    expect(powMod(FP5_DTH_ROOT, 5n, P)).toBe(1n);
    expect(FP5_DTH_ROOT).not.toBe(1n);
  });
});

describe('constants — the four Frobenius tables', () => {
  const tables: readonly (readonly bigint[])[] = [FROB1, FROB2, FROB3, FROB4];

  test('each has five entries and starts at one', () => {
    for (const t of tables) {
      expect(t.length).toBe(5);
      expect(t[0]).toBe(1n);
    }
  });

  test('FROB1[1]^5 === 1 — the defining fifth-root property', () => {
    expect(powMod(FROB1[1] as bigint, 5n, P)).toBe(1n);
    expect(FROB1[1]).toBe(FP5_DTH_ROOT);
  });

  test('FROB1[i] === FP5_DTH_ROOT^i', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(FROB1[i]).toBe(powMod(FP5_DTH_ROOT, BigInt(i), P));
    }
  });

  test('FROB2[i] === FROB1[i]^2, FROB3[i] === FROB1[i]^3, FROB4[i] === FROB1[i]^4', () => {
    for (let i = 0; i < 5; i += 1) {
      const base = FROB1[i] as bigint;
      expect(FROB2[i]).toBe((base * base) % P);
      expect(FROB3[i]).toBe(powMod(base, 3n, P));
      expect(FROB4[i]).toBe(powMod(base, 4n, P));
    }
  });

  test('table k applies x -> x^(p^k): coefficient i scales by d^(k*i)', () => {
    for (let k = 1; k <= 4; k += 1) {
      const table = tables[k - 1] as readonly bigint[];
      for (let i = 0; i < 5; i += 1) {
        expect(table[i]).toBe(powMod(FP5_DTH_ROOT, BigInt((k * i) % 5), P));
      }
    }
  });

  test('the fifth Frobenius is the identity — FROB4 composed with FROB1 is all ones', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(((FROB4[i] as bigint) * (FROB1[i] as bigint)) % P).toBe(1n);
    }
  });

  test('every entry is canonical and the tables are frozen', () => {
    for (const t of tables) {
      expect(Object.isFrozen(t)).toBe(true);
      for (const v of t) {
        expect(v >= 0n && v < P).toBe(true);
      }
    }
  });
});

const source = await readFile(
  new URL('../../../src/crypto/field/constants.ts', import.meta.url),
  'utf8',
);

describe('constants — module hygiene', () => {
  test('zero imports: every downstream unit depends on this file, so it depends on nothing', () => {
    expect(/^\s*import\s/m.test(source)).toBe(false);
    expect(source.includes('require(')).toBe(false);
  });

  test('no platform coupling', () => {
    expect(/from ['"]node:/.test(source)).toBe(false);
    expect(/\bBuffer\b/.test(source)).toBe(false);
    expect(/\bprocess\./.test(source)).toBe(false);
  });
});
