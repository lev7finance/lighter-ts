/**
 * Signed windowed recoding has no conformance vectors of its own — it is an internal
 * representation, not a wire format — so the whole test is the defining identity plus the two
 * mistakes that make a wrong recoding look right.
 *
 * 1. **Exactness.** `sum(d_i * 2^(w*i)) === m`, checked over thousands of seeded inputs across
 *    several widths and counts. Every other property is downstream of this one.
 * 2. **The asymmetric digit range.** `[-15, +16]` for `w = 5`, with `+16` reachable. A window table
 *    sized for `[-16, +15]` overflows on the top digit and nothing else here would notice.
 * 3. **Truncation throws.** Recoding a value that does not fit in `count` windows silently denotes a
 *    different integer, which is the exact shape of the 33-vs-64 digit bug: small scalars still
 *    produce the right point.
 * 4. **`recodeSigned5` covers the full signed 161-bit domain**, endpoints included.
 */

import { describe, expect, test } from 'bun:test';

import { LighterMathError } from '../../../src/errors.js';
import { recodeSigned5, recodeSignedDigits } from '../../../src/crypto/field/recode.js';

const MASK64 = 0xffffffffffffffffn;

/** splitmix64 — deterministic, dependency-free, and identical on every runtime. */
function makeRng(seed: bigint): () => bigint {
  let state = seed & MASK64;
  return (): bigint => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  };
}

/** A uniform draw from `[0, 2^bits)`. */
function randomBits(rng: () => bigint, bits: number): bigint {
  let v = 0n;
  for (let got = 0; got < bits; got += 64) v = (v << 64n) | rng();
  return v & ((1n << BigInt(bits)) - 1n);
}

/** The identity the module exists to satisfy. */
function recompose(digits: Int32Array, w: number): bigint {
  const radix = 1n << BigInt(w);
  let v = 0n;
  for (let i = digits.length - 1; i >= 0; i -= 1) v = v * radix + BigInt(digits[i] ?? 0);
  return v;
}

describe('recodeSignedDigits — exactness', () => {
  test('round-trips small integers at width 5', () => {
    for (let m = 0; m < 4096; m += 1) {
      const digits = recodeSignedDigits(BigInt(m), 16, 5);
      expect(recompose(digits, 5)).toBe(BigInt(m));
    }
  });

  test('round-trips 2000 seeded 319-bit values at width 5, 64 digits', () => {
    const rng = makeRng(0x5ca1ab1e_00000001n);
    for (let i = 0; i < 2000; i += 1) {
      const m = randomBits(rng, 319);
      const digits = recodeSignedDigits(m, 64, 5);
      expect(digits.length).toBe(64);
      expect(recompose(digits, 5)).toBe(m);
    }
  });

  test('round-trips across widths 2..16', () => {
    const rng = makeRng(0x5ca1ab1e_00000002n);
    for (let w = 2; w <= 16; w += 1) {
      const count = Math.ceil(256 / w) + 1;
      for (let i = 0; i < 60; i += 1) {
        const m = randomBits(rng, 256);
        const digits = recodeSignedDigits(m, count, w);
        expect(recompose(digits, w)).toBe(m);
      }
    }
  });

  test('zero recodes to all-zero digits', () => {
    const digits = recodeSignedDigits(0n, 64, 5);
    expect(digits.every((d) => d === 0)).toBe(true);
  });

  test('a zero digit count is legal only for zero', () => {
    expect(recodeSignedDigits(0n, 0, 5).length).toBe(0);
    expect(() => recodeSignedDigits(1n, 0, 5)).toThrow(LighterMathError);
  });
});

describe('recodeSignedDigits — the asymmetric digit range', () => {
  test('every digit of a width-5 recoding lies in [-15, 16]', () => {
    const rng = makeRng(0x5ca1ab1e_00000003n);
    for (let i = 0; i < 500; i += 1) {
      const digits = recodeSignedDigits(randomBits(rng, 319), 64, 5);
      for (const d of digits) {
        expect(d).toBeGreaterThanOrEqual(-15);
        expect(d).toBeLessThanOrEqual(16);
      }
    }
  });

  test('+16 is reachable, so a table sized for [-16, +15] is wrong', () => {
    const digits = recodeSignedDigits(16n, 4, 5);
    expect(digits[0]).toBe(16);
  });

  test('the carry rule is a strict >, so 17 becomes (-15, +1)', () => {
    const digits = recodeSignedDigits(17n, 4, 5);
    expect(digits[0]).toBe(-15);
    expect(digits[1]).toBe(1);
    expect(recompose(digits, 5)).toBe(17n);
  });

  test('a full window plus a carry produces digit 0 and propagates', () => {
    // chunk = 31, carry-in 1 -> v = 32 > 16 -> digit 0, carry 1.
    const digits = recodeSignedDigits(0x3ffn, 4, 5); // 31 + 31*32
    expect(recompose(digits, 5)).toBe(0x3ffn);
    expect(digits[0]).toBe(-1);
    expect(digits[1]).toBe(0);
    expect(digits[2]).toBe(1);
  });

  test('digits at width w stay within [-(2^(w-1) - 1), 2^(w-1)]', () => {
    const rng = makeRng(0x5ca1ab1e_00000004n);
    for (let w = 2; w <= 16; w += 1) {
      const lo = -((1 << (w - 1)) - 1);
      const hi = 1 << (w - 1);
      const digits = recodeSignedDigits(randomBits(rng, 200), Math.ceil(200 / w) + 1, w);
      for (const d of digits) {
        expect(d).toBeGreaterThanOrEqual(lo);
        expect(d).toBeLessThanOrEqual(hi);
      }
    }
  });
});

describe('recodeSignedDigits — rejections', () => {
  test('a negative input throws rather than sign-extending', () => {
    expect(() => recodeSignedDigits(-1n, 64, 5)).toThrow(LighterMathError);
  });

  test('truncation throws instead of returning digits for a different integer', () => {
    // 33 width-5 digits cover 165 bits; a 319-bit scalar does not fit.
    const big = (1n << 318n) + 12345n;
    expect(() => recodeSignedDigits(big, 33, 5)).toThrow(LighterMathError);
    expect(() => recodeSignedDigits(1n << 20n, 4, 5)).toThrow(LighterMathError);
  });

  test('the boundary between fits and does not fit is exact', () => {
    // 4 digits of width 5 represent [0, 2^20) with the final carry absorbed.
    expect(recompose(recodeSignedDigits((1n << 20n) - 1n, 5, 5), 5)).toBe((1n << 20n) - 1n);
    expect(() => recodeSignedDigits((1n << 20n) - 1n, 4, 5)).toThrow(LighterMathError);
  });

  test('an invalid count or width throws', () => {
    expect(() => recodeSignedDigits(1n, -1, 5)).toThrow(LighterMathError);
    expect(() => recodeSignedDigits(1n, 1.5, 5)).toThrow(LighterMathError);
    expect(() => recodeSignedDigits(1n, 64, 1)).toThrow(LighterMathError);
    expect(() => recodeSignedDigits(1n, 64, 32)).toThrow(LighterMathError);
    expect(() => recodeSignedDigits(1n, 64, 5.5)).toThrow(LighterMathError);
  });
});

describe('recodeSigned5 — the 161-bit signed variant', () => {
  const OFFSET = 1n << 160n;

  test('returns 33 digits', () => {
    expect(recodeSigned5(0n).length).toBe(33);
  });

  test('reconstructs the endpoints and the obvious small cases', () => {
    for (const v of [0n, 1n, -1n, 2n, -2n, OFFSET - 1n, -OFFSET, (1n << 159n) - 1n, -(1n << 159n)]) {
      expect(recompose(recodeSigned5(v), 5)).toBe(v);
    }
  });

  test('reconstructs 2000 seeded values across the whole signed domain', () => {
    const rng = makeRng(0x5ca1ab1e_00000005n);
    for (let i = 0; i < 2000; i += 1) {
      const v = randomBits(rng, 161) - OFFSET;
      expect(recompose(recodeSigned5(v), 5)).toBe(v);
    }
  });

  test('digits stay inside the width-5 range, top digit included', () => {
    const rng = makeRng(0x5ca1ab1e_00000006n);
    for (let i = 0; i < 500; i += 1) {
      const digits = recodeSigned5(randomBits(rng, 161) - OFFSET);
      for (const d of digits) {
        expect(d).toBeGreaterThanOrEqual(-15);
        expect(d).toBeLessThanOrEqual(16);
      }
      expect(digits[32]).toBeGreaterThanOrEqual(-1);
      expect(digits[32]).toBeLessThanOrEqual(1);
    }
  });

  test('rejects values outside [-2^160, 2^160)', () => {
    expect(() => recodeSigned5(OFFSET)).toThrow(LighterMathError);
    expect(() => recodeSigned5(-OFFSET - 1n)).toThrow(LighterMathError);
  });

  test('is not a scalar recoder: 33 digits cannot hold a 319-bit value', () => {
    expect(() => recodeSigned5((1n << 318n) + 7n)).toThrow(LighterMathError);
  });
});
