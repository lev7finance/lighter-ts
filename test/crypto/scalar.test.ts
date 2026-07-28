/**
 * The scalar field is where a correct-looking implementation stops being able to sign.
 *
 * `s = (k - e*sk) mod n` is negative about half the time, and JavaScript's `%` follows the sign of
 * the dividend — so `(k - e * sk) % N` yields a negative `bigint` that serializes to a different,
 * invalid scalar while every field, hash and curve operation remains perfectly correct
 * (`docs/protocol-notes.md` §5.0). Half of this file exists for that one bug.
 *
 * Five layers:
 *
 * 1. **The modulus** — decimal, hex and little-endian limb forms cross-checked against each other,
 *    so a transcription slip cannot survive.
 * 2. **Vectors** — all 11 `scalarCases` rows of `conformance/vectors/curve.json`, which pin the
 *    reducing decoder (four of them are out of range), plus every private key and pinned nonce in
 *    `conformance/vectors/schnorr.json`.
 * 3. **The sign trap** — explicit regressions on `modN(-1n)` and `scalarSub(0n, 1n)`, and a
 *    reconstruction of the signing equation itself.
 * 4. **Properties** — 2000 seeded iterations per law.
 * 5. **Recoding** — 64 digits, not 33, with the identity and the digit range asserted.
 */

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  N,
  SCALAR_BYTES,
  modN,
  recodeScalar5,
  scalarAdd,
  scalarFromBytes,
  scalarFromBytesStrict,
  scalarFromFp5,
  scalarIsCanonicalBytes,
  scalarMul,
  scalarNeg,
  scalarSub,
  scalarToBytes,
  type Fp5Like,
} from '../../src/crypto/scalar.js';
import { P } from '../../src/crypto/field/constants.js';
import { LighterSignatureError } from '../../src/errors.js';
import { bytesToHex, hexToBytes } from '../../src/util/bytes.js';

const curveUrl = new URL('../../conformance/vectors/curve.json', import.meta.url);
const curve = JSON.parse(await readFile(curveUrl, 'utf8')) as {
  scalarCases: readonly {
    inputLeHex: string;
    scalar: readonly string[];
    inputWasInRange: boolean;
    wasReduced: boolean;
    outputLeHex: string;
  }[];
};

const schnorrUrl = new URL('../../conformance/vectors/schnorr.json', import.meta.url);
const schnorr = JSON.parse(await readFile(schnorrUrl, 'utf8')) as {
  cases: readonly {
    privateKeyLeHex: string;
    nonceKLeHex: string;
    sigS: readonly string[];
    sigE: readonly string[];
  }[];
};

const MASK64 = 0xffffffffffffffffn;

/** splitmix64 — deterministic, dependency-free, identical on every runtime. */
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

/** `sum(limb_i * 2^(64 i))` — how a five-element limb array in the vectors is read. */
function fromLimbs(limbs: readonly string[]): bigint {
  let v = 0n;
  for (let i = limbs.length - 1; i >= 0; i -= 1) v = (v << 64n) | BigInt(limbs[i] ?? '0');
  return v;
}

describe('N — the group order', () => {
  test('decimal, hex and little-endian limb forms agree', () => {
    expect(N).toBe(
      BigInt('0x7FFFFFFD800000077FFFFFF1000000167FFFFFE6CFB80639E8885C39D724A09CE80FD996948BFFE1'),
    );
    const limbs = [
      0xe80fd996948bffe1n,
      0xe8885c39d724a09cn,
      0x7fffffe6cfb80639n,
      0x7ffffff100000016n,
      0x7ffffffd80000007n,
    ];
    let composed = 0n;
    for (let i = limbs.length - 1; i >= 0; i -= 1) composed = (composed << 64n) | (limbs[i] ?? 0n);
    expect(composed).toBe(N);
  });

  test('is 319 bits and odd', () => {
    expect(N.toString(2).length).toBe(319);
    expect(N & 1n).toBe(1n);
  });

  test('is not the base field modulus, and is far larger', () => {
    expect(N).not.toBe(P);
    expect(N > P).toBe(true);
  });

  test('is prime by a Miller-Rabin round set that is deterministic in practice', () => {
    const d0 = N - 1n;
    let r = 0n;
    let d = d0;
    while ((d & 1n) === 0n) {
      d >>= 1n;
      r += 1n;
    }
    const powMod = (base: bigint, exp: bigint, m: bigint): bigint => {
      let acc = 1n;
      let b = base % m;
      let e = exp;
      while (e > 0n) {
        if ((e & 1n) === 1n) acc = (acc * b) % m;
        b = (b * b) % m;
        e >>= 1n;
      }
      return acc;
    };
    for (const a of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
      let x = powMod(a, d, N);
      if (x === 1n || x === N - 1n) continue;
      let witness = true;
      for (let i = 1n; i < r; i += 1n) {
        x = (x * x) % N;
        if (x === N - 1n) {
          witness = false;
          break;
        }
      }
      expect(witness).toBe(false);
    }
  });

  test('SCALAR_BYTES is 40, which is five 64-bit limbs', () => {
    expect<number>(SCALAR_BYTES).toBe(40);
    expect(N < 1n << BigInt(8 * SCALAR_BYTES)).toBe(true);
  });

  test('40 bytes hold almost three times N, so one conditional subtraction is not enough', () => {
    const max = (1n << 320n) - 1n;
    expect(max / N).toBe(2n);
    expect(max - N - N >= N).toBe(false);
    expect(max - N >= N).toBe(true); // a single `if (v >= N) v -= N` would leave this unreduced
    expect(modN(max)).toBe(max - 2n * N);
  });
});

describe('modN — the sign trap', () => {
  test('modN(-1n) is N - 1, not -1', () => {
    expect(modN(-1n)).toBe(N - 1n);
  });

  test('scalarSub(0n, 1n) is N - 1', () => {
    expect(scalarSub(0n, 1n)).toBe(N - 1n);
  });

  test('scalarNeg(0n) is 0, not N', () => {
    expect(scalarNeg(0n)).toBe(0n);
  });

  test('the signing equation stays in range when k < e*sk', () => {
    // The literal `(k - e * sk) % N` is negative here; modN must not be.
    const k = 5n;
    const e = 7n;
    const sk = 11n;
    const raw = k - e * sk;
    expect(raw < 0n).toBe(true);
    expect(raw % N < 0n).toBe(true);
    const s = scalarSub(k, scalarMul(e, sk));
    expect(s).toBe(N + raw);
    expect(s >= 0n && s < N).toBe(true);
  });

  test('a negative scalar never survives serialization', () => {
    // What a negative intermediate would encode to, versus what it must encode to.
    const s = scalarSub(3n, 10n);
    expect(s).toBe(N - 7n);
    expect(bytesToHex(scalarToBytes(s))).toBe(bytesToHex(scalarToBytes(N - 7n)));
    expect(scalarFromBytes(scalarToBytes(s))).toBe(N - 7n);
  });

  test('reduces inputs of every sign and magnitude into [0, N)', () => {
    const rng = makeRng(0xdecafbadn);
    for (let i = 0; i < 2000; i += 1) {
      const magnitude = randomBits(rng, 400);
      const x = (rng() & 1n) === 1n ? -magnitude : magnitude;
      const r = modN(x);
      expect(r >= 0n && r < N).toBe(true);
      expect((x - r) % N).toBe(0n);
    }
  });
});

describe('scalarCases — the 11 pinned reduction vectors', () => {
  test('there are 11 rows and four of them are out of range', () => {
    expect(curve.scalarCases.length).toBe(11);
    expect(curve.scalarCases.filter((c) => !c.inputWasInRange).length).toBe(4);
  });

  test('scalarFromBytes matches the pinned limb decomposition', () => {
    for (const c of curve.scalarCases) {
      expect(scalarFromBytes(hexToBytes(c.inputLeHex))).toBe(fromLimbs(c.scalar));
    }
  });

  test('re-encoding produces outputLeHex byte for byte', () => {
    for (const c of curve.scalarCases) {
      expect(bytesToHex(scalarToBytes(scalarFromBytes(hexToBytes(c.inputLeHex))))).toBe(
        c.outputLeHex,
      );
    }
  });

  test('scalarIsCanonicalBytes agrees with inputWasInRange, and wasReduced with the diff', () => {
    for (const c of curve.scalarCases) {
      expect(scalarIsCanonicalBytes(hexToBytes(c.inputLeHex))).toBe(c.inputWasInRange);
      expect(c.outputLeHex !== c.inputLeHex).toBe(c.wasReduced);
    }
  });

  test('scalarFromBytesStrict rejects exactly the out-of-range rows', () => {
    for (const c of curve.scalarCases) {
      const bytes = hexToBytes(c.inputLeHex);
      if (c.inputWasInRange) {
        expect(scalarFromBytesStrict(bytes)).toBe(scalarFromBytes(bytes));
      } else {
        expect(() => scalarFromBytesStrict(bytes)).toThrow(LighterSignatureError);
      }
    }
  });
});

describe('the 40-byte codec', () => {
  test('byte 8i + j is byte j of limb i', () => {
    // Limb 0 = 1, limb 3 = 2 -> byte 0 is 0x01 and byte 24 is 0x02.
    const s = 1n + (2n << (64n * 3n));
    const bytes = scalarToBytes(s);
    expect(bytes[0]).toBe(1);
    expect(bytes[24]).toBe(2);
    expect(bytes.length).toBe(40);
    expect(scalarFromBytes(bytes)).toBe(s);
  });

  test('encodes zero and N - 1 exactly', () => {
    expect(bytesToHex(scalarToBytes(0n))).toBe('00'.repeat(40));
    expect(scalarFromBytes(scalarToBytes(N - 1n))).toBe(N - 1n);
    expect(bytesToHex(scalarToBytes(N))).toBe('00'.repeat(40)); // N reduces to 0
  });

  test('both decoders reject any length other than 40', () => {
    for (const len of [0, 1, 39, 41, 80]) {
      const bytes = new Uint8Array(len);
      expect(() => scalarFromBytes(bytes)).toThrow(LighterSignatureError);
      expect(() => scalarFromBytesStrict(bytes)).toThrow(LighterSignatureError);
      expect(scalarIsCanonicalBytes(bytes)).toBe(false);
    }
  });

  test('the reference ignore-the-tail behaviour is not reproduced', () => {
    const forty = scalarToBytes(12345n);
    const fortyOne = new Uint8Array(41);
    fortyOne.set(forty, 0);
    expect(() => scalarFromBytes(fortyOne)).toThrow(LighterSignatureError);
  });

  test('decodes from a view into a larger buffer without reading past it', () => {
    const backing = new Uint8Array(64).fill(0xff);
    const value = scalarToBytes(0xdeadbeefn);
    backing.set(value, 8);
    expect(scalarFromBytes(backing.subarray(8, 48))).toBe(0xdeadbeefn);
  });

  test('s + N and s + 2N decode to the same scalar as s', () => {
    const s = 0x1234_5678n;
    const encode = (v: bigint): Uint8Array => {
      const out = new Uint8Array(40);
      let x = v;
      for (let i = 0; i < 40; i += 1) {
        out[i] = Number(x & 0xffn);
        x >>= 8n;
      }
      return out;
    };
    expect(scalarFromBytes(encode(s + N))).toBe(s);
    expect(scalarFromBytes(encode(s + 2n * N))).toBe(s);
    expect(scalarIsCanonicalBytes(encode(s + N))).toBe(false);
  });
});

describe('schnorr.json keys and nonces', () => {
  test('there are 16 cases', () => {
    expect(schnorr.cases.length).toBe(16);
  });

  test('every private key and pinned nonce is canonical and round-trips byte-identically', () => {
    for (const c of schnorr.cases) {
      for (const hex of [c.privateKeyLeHex, c.nonceKLeHex]) {
        const bytes = hexToBytes(hex);
        expect(bytes.length).toBe(40);
        expect(scalarIsCanonicalBytes(bytes)).toBe(true);
        const s = scalarFromBytes(bytes);
        expect(s).toBe(scalarFromBytesStrict(bytes));
        expect(s > 0n && s < N).toBe(true);
        expect(bytesToHex(scalarToBytes(s))).toBe(hex);
      }
    }
  });

  test('both signature halves are in range and match their limb form', () => {
    for (const c of schnorr.cases) {
      for (const limbs of [c.sigS, c.sigE]) {
        const v = fromLimbs(limbs);
        expect(v < N).toBe(true);
        expect(scalarFromBytes(scalarToBytes(v))).toBe(v);
      }
    }
  });
});

describe('field laws', () => {
  test('2000 seeded iterations of the arithmetic laws', () => {
    const rng = makeRng(0x0ddba11n);
    for (let i = 0; i < 2000; i += 1) {
      const a = modN(randomBits(rng, 320));
      const b = modN(randomBits(rng, 320));

      expect(scalarAdd(a, b)).toBe(modN(a + b));
      expect(scalarSub(a, b)).toBe(modN(a - b));
      expect(scalarMul(a, b)).toBe(modN(a * b));
      expect(scalarAdd(a, scalarNeg(a))).toBe(0n);
      expect(scalarSub(a, b)).toBe(scalarAdd(a, scalarNeg(b)));
      expect(scalarAdd(a, b)).toBe(scalarAdd(b, a));
      expect(scalarMul(a, b)).toBe(scalarMul(b, a));

      for (const v of [a, b, scalarAdd(a, b), scalarSub(a, b), scalarMul(a, b)]) {
        expect(v >= 0n && v < N).toBe(true);
      }
    }
  });

  test('the codec round-trips and is idempotent', () => {
    const rng = makeRng(0xc0ffeen);
    for (let i = 0; i < 2000; i += 1) {
      const raw = randomBits(rng, 320);
      const bytes = new Uint8Array(40);
      let x = raw;
      for (let j = 0; j < 40; j += 1) {
        bytes[j] = Number(x & 0xffn);
        x >>= 8n;
      }
      const first = scalarFromBytes(bytes);
      const encoded = scalarToBytes(first);
      expect(scalarFromBytes(encoded)).toBe(first);
      expect(bytesToHex(scalarToBytes(scalarFromBytes(encoded)))).toBe(bytesToHex(encoded));
      expect(scalarIsCanonicalBytes(encoded)).toBe(true);
      expect(first).toBe(raw % N);
    }
  });
});

describe('scalarFromFp5 — the challenge conversion', () => {
  const asFp5 = (c: readonly bigint[]): Fp5Like =>
    [c[0] ?? 0n, c[1] ?? 0n, c[2] ?? 0n, c[3] ?? 0n, c[4] ?? 0n] as const;

  test('coefficient 0 is the least significant limb', () => {
    expect(scalarFromFp5(asFp5([1n, 0n, 0n, 0n, 0n]))).toBe(1n);
    expect(scalarFromFp5(asFp5([0n, 1n, 0n, 0n, 0n]))).toBe(modN(1n << 64n));
    expect(scalarFromFp5(asFp5([0n, 0n, 0n, 0n, 1n]))).toBe(modN(1n << 256n));
  });

  test('assembles sum(h_i * 2^(64 i)) and reduces, over 2000 seeded elements', () => {
    const rng = makeRng(0xfeedfacen);
    for (let i = 0; i < 2000; i += 1) {
      const coeffs: bigint[] = [];
      for (let j = 0; j < 5; j += 1) coeffs.push(rng() % P);
      let expected = 0n;
      for (let j = 4; j >= 0; j -= 1) expected = (expected << 64n) | (coeffs[j] ?? 0n);
      const s = scalarFromFp5(asFp5(coeffs));
      expect(s).toBe(expected % N);
      expect(s >= 0n && s < N).toBe(true);
    }
  });

  test('a partially reduced coefficient canonicalizes rather than overflowing its limb', () => {
    // The Go reference stores elements that may sit one p above the true residue.
    expect(scalarFromFp5(asFp5([P + 4n, 0n, 0n, 0n, 0n]))).toBe(4n);
    expect(scalarFromFp5(asFp5([4n, 0n, 0n, 0n, 0n]))).toBe(4n);
    expect(scalarFromFp5(asFp5([0n, P, 0n, 0n, 0n]))).toBe(0n);
  });

  test('all-max coefficients still land in range', () => {
    const s = scalarFromFp5(asFp5([P - 1n, P - 1n, P - 1n, P - 1n, P - 1n]));
    expect(s >= 0n && s < N).toBe(true);
  });
});

describe('recodeScalar5', () => {
  const recompose = (digits: Int32Array): bigint => {
    let v = 0n;
    for (let i = digits.length - 1; i >= 0; i -= 1) v = v * 32n + BigInt(digits[i] ?? 0);
    return v;
  };

  const check = (s: bigint): void => {
    const digits = recodeScalar5(s);
    expect(digits.length).toBe(64);
    for (const d of digits) {
      expect(d).toBeGreaterThanOrEqual(-15);
      expect(d).toBeLessThanOrEqual(16);
    }
    expect(digits[63]).toBeGreaterThanOrEqual(0);
    expect(recompose(digits)).toBe(s);
  };

  test('64 digits, not 33 — 33 would cover only 165 bits', () => {
    expect(recodeScalar5(0n).length).toBe(64);
    expect(recodeScalar5(0n).length * 5).toBeGreaterThan(319);
  });

  test('the boundary cases', () => {
    check(0n);
    check(1n);
    check(2n);
    check(15n);
    check(16n);
    check(17n);
    check(N - 1n);
    check(N - 2n);
    check((1n << 318n) - 1n);
  });

  test('200 seeded scalars', () => {
    const rng = makeRng(0xbadc0den);
    for (let i = 0; i < 200; i += 1) check(modN(randomBits(rng, 320)));
  });

  test('reduces its input first, so N recodes as zero', () => {
    expect(recompose(recodeScalar5(N))).toBe(0n);
    expect(recompose(recodeScalar5(-1n))).toBe(N - 1n);
  });

  test('every real private key recodes exactly — the truncation bug would not', () => {
    for (const c of schnorr.cases) {
      const sk = scalarFromBytes(hexToBytes(c.privateKeyLeHex));
      expect(sk > 1n << 300n).toBe(true); // well past what 33 digits could hold
      check(sk);
    }
  });
});
