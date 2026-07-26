/**
 * The nonce is the one thing in this SDK that nothing else can check.
 *
 * `k` never reaches the wire. Verification reconstructs `R` and recomputes the challenge; it cannot
 * observe where `k` came from. So a constant nonce, a nonce with the two 320-bit halves swapped, a
 * nonce whose seed silently dropped the message, or a nonce reduced from a biased 320-bit draw all
 * produce signatures that pass every conformance vector, that the Go verifier accepts, and that the
 * sequencer executes — while leaking the private key to anyone who collects two of them.
 *
 * This file is therefore the entire safety net for `src/crypto/nonce.ts`. It is organised as:
 *
 * 1. **Vectors** — `nonce-vectors.json`, replayed byte-for-byte. Generated once by the
 *    implementation and cross-checked by hand against an independent Python derivation whose
 *    Poseidon2 was validated against all 45 `hashToQuinticExtension` rows and all 16 permutation rows
 *    of `conformance/vectors/poseidon2.json`. If a row here changes, the derivation changed.
 * 2. **Injectivity** — 256 single-bit message changes and 256 single-bit key changes, zero
 *    collisions. This is what catches a seed that lost `msgBytes` or `skBytes` to a slice bug.
 * 3. **Range** — `k` in `[1, n)` everywhere, including 1000 seeded random triples.
 * 4. **Determinism and hedging** — identical inputs give identical `k`; a zero-entropy source makes
 *    `chooseNonce` reproducible; a real source makes it not.
 * 5. **The reason all of this exists** — an explicit key-recovery from two signatures that reused
 *    `k`, performed with scalar arithmetic alone.
 * 6. **Modes, lengths, diagnostics, and module-scope purity.**
 *
 * The randomness stubs install and remove `globalThis.crypto` around each test, so "no CSPRNG
 * present" is exercised in-process. Whether the *module* touches randomness at import time cannot be
 * tested in-process at all — the module is already loaded — so that one runs in a subprocess.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  chooseNonce,
  deriveNonceHedged,
  randomNonce,
  type NonceOption,
} from '../../src/crypto/nonce.js';
import { LighterSignatureError } from '../../src/errors.js';
import { N, modN, scalarToBytes, type Scalar } from '../../src/crypto/scalar.js';

const NONCE_SRC_URL = new URL('../../src/crypto/nonce.ts', import.meta.url);

const vectorsUrl = new URL('./nonce-vectors.json', import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, 'utf8')) as {
  name: string;
  note: string;
  cases: {
    description: string;
    skLeHex: string;
    msgLeHex: string;
    entropyHex: string;
    kLeHex: string;
  }[];
};

/* ------------------------------------------------------------------ helpers */

function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Little-endian bytes to a `bigint`, written independently of the implementation's own decoder. */
function leToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i -= 1) v = (v << 8n) | BigInt(b[i] ?? 0);
  return v;
}

/** splitmix64 — a seeded, portable PRNG so the property runs are reproducible on every machine. */
function splitmix64(seed: bigint): () => bigint {
  const MASK = (1n << 64n) - 1n;
  let s = seed & MASK;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & MASK;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return z ^ (z >> 31n);
  };
}

function randomBytes(next: () => bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 8) {
    let word = next();
    for (let j = 0; j < 8 && i + j < len; j += 1) {
      out[i + j] = Number(word & 0xffn);
      word >>= 8n;
    }
  }
  return out;
}

const ZERO_ENTROPY = new Uint8Array(32);

/** Modular inverse in `Z/nZ` by Fermat: `x^(n-2) mod n`. Used only by the key-recovery test. */
function invModN(x: Scalar): Scalar {
  let base = modN(x);
  let e = N - 2n;
  let acc = 1n;
  while (e > 0n) {
    if ((e & 1n) === 1n) acc = (acc * base) % N;
    base = (base * base) % N;
    e >>= 1n;
  }
  return acc;
}

/* --------------------------------------------------- randomness stub plumbing */

const ORIGINAL_CRYPTO = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

/** Install an object as `globalThis.crypto`; `undefined` removes it entirely. */
function setCrypto(value: unknown): void {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, 'crypto');
    return;
  }
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
}

function restoreCrypto(): void {
  if (ORIGINAL_CRYPTO === undefined) {
    Reflect.deleteProperty(globalThis, 'crypto');
    return;
  }
  Object.defineProperty(globalThis, 'crypto', ORIGINAL_CRYPTO);
}

/** A CSPRNG stub that records every request length and fills deterministically. */
function recordingSource(fill: (buf: Uint8Array, call: number) => void): {
  lengths: number[];
  crypto: { getRandomValues: (b: Uint8Array) => Uint8Array };
} {
  const lengths: number[] = [];
  let call = 0;
  return {
    lengths,
    crypto: {
      getRandomValues: (b: Uint8Array): Uint8Array => {
        lengths.push(b.length);
        fill(b, call);
        call += 1;
        return b;
      },
    },
  };
}

afterEach(() => {
  restoreCrypto();
});

/* ------------------------------------------------------------------- vectors */

describe('nonce-vectors.json — the pinned LighterNonce-P2-v1 derivation', () => {
  test('the file covers every input shape the derivation has to survive', () => {
    expect(vectors.name).toBe('LighterNonce-P2-v1');
    expect(vectors.cases.length).toBeGreaterThanOrEqual(7);

    const zeroEntropy = vectors.cases.filter((c) => /^0+$/.test(c.entropyHex));
    expect(zeroEntropy.length).toBeGreaterThanOrEqual(5);
    expect(vectors.cases.some((c) => !/^0+$/.test(c.entropyHex))).toBe(true);
    expect(vectors.cases.some((c) => /^0+$/.test(c.msgLeHex))).toBe(true);
    // sk = 1 and sk = N - 1, the two ends of the scalar range.
    expect(vectors.cases.some((c) => c.skLeHex === bytesToHex(scalarToBytes(1n)))).toBe(true);
    expect(vectors.cases.some((c) => c.skLeHex === bytesToHex(scalarToBytes(N - 1n)))).toBe(true);
  });

  for (const [i, c] of vectors.cases.entries()) {
    test(`case ${i}: ${c.description}`, () => {
      const k = deriveNonceHedged(
        hexToBytes(c.skLeHex),
        hexToBytes(c.msgLeHex),
        hexToBytes(c.entropyHex),
      );
      expect(bytesToHex(scalarToBytes(k))).toBe(c.kLeHex);
      expect(k).toBe(leToBigInt(hexToBytes(c.kLeHex)));
      expect(k).toBeGreaterThanOrEqual(1n);
      expect(k).toBeLessThan(N);
    });
  }

  test('every row produces a distinct k — no two of these inputs collide', () => {
    const seen = new Set(vectors.cases.map((c) => c.kLeHex));
    expect(seen.size).toBe(vectors.cases.length);
  });

  test('the same-key/different-message pair really is same-key and different-message', () => {
    const [a, b] = vectors.cases;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a === undefined || b === undefined) return;
    expect(b.skLeHex).toBe(a.skLeHex);
    expect(b.msgLeHex).not.toBe(a.msgLeHex);
    expect(b.kLeHex).not.toBe(a.kLeHex);
  });

  test('the different-key/same-message pair really is different-key and same-message', () => {
    const a = vectors.cases[0];
    const c = vectors.cases[2];
    expect(a).toBeDefined();
    expect(c).toBeDefined();
    if (a === undefined || c === undefined) return;
    expect(c.msgLeHex).toBe(a.msgLeHex);
    expect(c.skLeHex).not.toBe(a.skLeHex);
    expect(c.kLeHex).not.toBe(a.kLeHex);
  });

  test('entropy changes the nonce: the non-zero-entropy row differs from its zero-entropy twin', () => {
    const zero = vectors.cases[0];
    const hedged = vectors.cases[3];
    expect(zero).toBeDefined();
    expect(hedged).toBeDefined();
    if (zero === undefined || hedged === undefined) return;
    expect(hedged.skLeHex).toBe(zero.skLeHex);
    expect(hedged.msgLeHex).toBe(zero.msgLeHex);
    expect(hedged.entropyHex).not.toBe(zero.entropyHex);
    expect(hedged.kLeHex).not.toBe(zero.kLeHex);
  });
});

/* -------------------------------------------------------------- injectivity */

describe('injectivity — the property a signature test cannot see', () => {
  const sk = new Uint8Array(40).map((_, i) => i + 1);
  const msg = new Uint8Array(40).map((_, i) => 0xa0 + i);

  test('same key, different message → different k, over 320 single-bit message changes', () => {
    const seen = new Map<bigint, number>();
    const base = deriveNonceHedged(sk, msg, ZERO_ENTROPY);
    seen.set(base, -1);

    for (let bit = 0; bit < 320; bit += 1) {
      const m = new Uint8Array(msg);
      const idx = bit >> 3;
      m[idx] = (m[idx] ?? 0) ^ (1 << (bit & 7));
      const k = deriveNonceHedged(sk, m, ZERO_ENTROPY);
      expect(k).toBeGreaterThanOrEqual(1n);
      expect(k).toBeLessThan(N);
      // A collision here means one bit of the message is not reaching the seed — which is exactly
      // the shape of "the derivation dropped the message" and leaks the key on the second signature.
      expect(seen.has(k)).toBe(false);
      seen.set(k, bit);
    }
    expect(seen.size).toBe(321);
  });

  test('different key, same message → different k, over 320 single-bit key changes', () => {
    const seen = new Set<bigint>();
    seen.add(deriveNonceHedged(sk, msg, ZERO_ENTROPY));

    for (let bit = 0; bit < 320; bit += 1) {
      const s = new Uint8Array(sk);
      const idx = bit >> 3;
      s[idx] = (s[idx] ?? 0) ^ (1 << (bit & 7));
      const k = deriveNonceHedged(s, msg, ZERO_ENTROPY);
      expect(k).toBeGreaterThanOrEqual(1n);
      expect(k).toBeLessThan(N);
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
    expect(seen.size).toBe(321);
  });

  test('every entropy bit reaches the seed: 256 single-bit entropy changes, no collisions', () => {
    const seen = new Set<bigint>();
    seen.add(deriveNonceHedged(sk, msg, ZERO_ENTROPY));

    for (let bit = 0; bit < 256; bit += 1) {
      const e = new Uint8Array(ZERO_ENTROPY);
      const idx = bit >> 3;
      e[idx] = (e[idx] ?? 0) ^ (1 << (bit & 7));
      const k = deriveNonceHedged(sk, msg, e);
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
    expect(seen.size).toBe(257);
  });

  test('the message is not merely appended to a key-only hash: swapping key and message changes k', () => {
    // Both are 40 bytes, so a derivation that concatenated them without positional meaning would
    // give the same answer for the swap. It must not.
    const a = deriveNonceHedged(sk, msg, ZERO_ENTROPY);
    const b = deriveNonceHedged(msg, sk, ZERO_ENTROPY);
    expect(a).not.toBe(b);
  });
});

/* --------------------------------------------------------------- range, bulk */

describe('k stays in [1, n)', () => {
  test('1000 seeded random (sk, msg, entropy) triples — all in range, all distinct', () => {
    const next = splitmix64(0x1eaf_c0de_1234_5678n);
    const seen = new Set<bigint>();

    for (let i = 0; i < 1000; i += 1) {
      const sk = randomBytes(next, 40);
      const msg = randomBytes(next, 40);
      const entropy = randomBytes(next, 32);
      const k = deriveNonceHedged(sk, msg, entropy);
      expect(k).toBeGreaterThanOrEqual(1n);
      expect(k).toBeLessThan(N);
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
    expect(seen.size).toBe(1000);
  });

  test('the derived nonce is wide — it is not a small value dressed up as a scalar', () => {
    // A truncation bug (say, only the low h0 half surviving, or a 64-bit fold) shows up as nonces
    // that never occupy the top of the range. Over 200 samples, at least one must exceed n/2 and at
    // least one must exceed 2^300.
    const next = splitmix64(0xfeed_beef_0bad_cafen);
    let aboveHalf = 0;
    let above300 = 0;
    for (let i = 0; i < 200; i += 1) {
      const k = deriveNonceHedged(randomBytes(next, 40), randomBytes(next, 40), randomBytes(next, 32));
      if (k > N / 2n) aboveHalf += 1;
      if (k > 1n << 300n) above300 += 1;
    }
    expect(aboveHalf).toBeGreaterThan(50);
    expect(above300).toBeGreaterThan(50);
  });
});

/* --------------------------------------------------- determinism and hedging */

describe('determinism and hedging', () => {
  const sk = new Uint8Array(40).map((_, i) => (i * 7 + 3) & 0xff);
  const msg = new Uint8Array(40).map((_, i) => (i * 11 + 5) & 0xff);

  test('deriveNonceHedged is pure: identical arguments, identical result', () => {
    const entropy = new Uint8Array(32).map((_, i) => (i * 31) & 0xff);
    const a = deriveNonceHedged(sk, msg, entropy);
    const b = deriveNonceHedged(new Uint8Array(sk), new Uint8Array(msg), new Uint8Array(entropy));
    expect(a).toBe(b);
  });

  test('deriveNonceHedged does not mutate its inputs', () => {
    const s = new Uint8Array(sk);
    const m = new Uint8Array(msg);
    const e = new Uint8Array(32).map((_, i) => i);
    deriveNonceHedged(s, m, e);
    expect(bytesToHex(s)).toBe(bytesToHex(sk));
    expect(bytesToHex(m)).toBe(bytesToHex(msg));
    expect(bytesToHex(e)).toBe(bytesToHex(new Uint8Array(32).map((_, i) => i)));
  });

  test('chooseNonce hedged with a zero-filled entropy source is deterministic and equals the zero-entropy derivation', () => {
    const src = recordingSource((b) => b.fill(0));
    setCrypto(src.crypto);

    const a = chooseNonce(sk, msg, 'hedged');
    const b = chooseNonce(sk, msg);
    expect(a).toBe(b);
    expect(a).toBe(deriveNonceHedged(sk, msg, ZERO_ENTROPY));
    // 32 bytes, per call, no more and no fewer.
    expect(src.lengths).toEqual([32, 32]);
  });

  test('chooseNonce hedged with a real entropy source repeats no nonce over 100 calls', () => {
    const src = recordingSource((b, call) => {
      // Distinct per call, so a nonce that ignored the entropy would collide immediately.
      b.fill(0);
      b[0] = call & 0xff;
      b[1] = (call >> 8) & 0xff;
    });
    setCrypto(src.crypto);

    const seen = new Set<bigint>();
    for (let i = 0; i < 100; i += 1) {
      const k = chooseNonce(sk, msg, 'hedged');
      expect(k).toBeGreaterThanOrEqual(1n);
      expect(k).toBeLessThan(N);
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
    expect(seen.size).toBe(100);
    expect(src.lengths).toEqual(new Array<number>(100).fill(32));
  });

  test('chooseNonce hedged with the platform CSPRNG repeats no nonce over 100 calls', () => {
    // No stub at all: whatever the real runtime provides.
    const seen = new Set<bigint>();
    for (let i = 0; i < 100; i += 1) seen.add(chooseNonce(sk, msg, 'hedged'));
    expect(seen.size).toBe(100);
  });
});

/* ------------------------------------------------- why the nonce is derived */

describe('the failure mode this whole file exists to prevent', () => {
  test('reusing k recovers the private key — this is why the nonce is derived, not drawn', () => {
    // Pure scalar arithmetic: no signer, no curve, no hashing. Two signatures under one key that
    // happen to share a nonce, exactly as a repeating or snapshot-restored RNG would produce.
    const sk = modN(0x5f3a_1c9e_dead_beefn * 0x9e37_79b9_7f4a_7c15n + 12345n);
    const k = modN(0x0123_4567_89ab_cdefn * 0xfedc_ba98_7654_3210n + 999n);
    const e1 = modN(0x1111_2222_3333_4444n);
    const e2 = modN(0x5555_6666_7777_8888n);
    expect(e1).not.toBe(e2);

    const s1 = modN(k - modN(e1 * sk));
    const s2 = modN(k - modN(e2 * sk));

    // sk = (s1 - s2) / (e2 - e1). One subtraction and one inversion; no search, no side channel.
    const recovered = modN(modN(s1 - s2) * invModN(modN(e2 - e1)));
    expect(recovered).toBe(sk);
  });

  test('the same recovery fails when the two signatures used different, derived nonces', () => {
    const skBytes = new Uint8Array(40).map((_, i) => i + 9);
    const m1 = new Uint8Array(40).map((_, i) => i);
    const m2 = new Uint8Array(40).map((_, i) => i + 1);
    const sk = modN(leToBigInt(skBytes));

    const k1 = deriveNonceHedged(skBytes, m1, ZERO_ENTROPY);
    const k2 = deriveNonceHedged(skBytes, m2, ZERO_ENTROPY);
    expect(k1).not.toBe(k2);

    const e1 = modN(0x1111_2222_3333_4444n);
    const e2 = modN(0x5555_6666_7777_8888n);
    const s1 = modN(k1 - modN(e1 * sk));
    const s2 = modN(k2 - modN(e2 * sk));

    const recovered = modN(modN(s1 - s2) * invModN(modN(e2 - e1)));
    expect(recovered).not.toBe(sk);
  });
});

/* ---------------------------------------------------------------- randomNonce */

describe('randomNonce', () => {
  test('draws exactly 64 bytes, once, from the platform CSPRNG', () => {
    const src = recordingSource((b) => {
      b.fill(0);
      b[0] = 7;
    });
    setCrypto(src.crypto);

    const k = randomNonce();
    expect(src.lengths).toEqual([64]);
    expect(k).toBe(7n);
  });

  test('40 bytes would be biased: the reduction of a full 64-byte draw is used, unreduced high bytes included', () => {
    // A draw whose value is n + 5 must come back as 5. If the implementation had truncated to 40
    // bytes it would still be n + 5 mod n = 5 here, so also feed a value that only a 64-byte reader
    // can see: bytes above index 39 must affect the result.
    const highOnly = new Uint8Array(64);
    highOnly[40] = 1; // 2^320 — invisible to a 40-byte draw
    const src = recordingSource((b) => b.set(highOnly));
    setCrypto(src.crypto);
    expect(randomNonce()).toBe(modN(1n << 320n));
  });

  test('throws LighterSignatureError when there is no CSPRNG', () => {
    setCrypto(undefined);
    expect(() => randomNonce()).toThrow(LighterSignatureError);
    setCrypto({});
    expect(() => randomNonce()).toThrow(LighterSignatureError);
    setCrypto({ getRandomValues: 'not a function' });
    expect(() => randomNonce()).toThrow(LighterSignatureError);
  });

  test('an all-zero source is refused rather than looped on forever', () => {
    const src = recordingSource((b) => b.fill(0));
    setCrypto(src.crypto);
    expect(() => randomNonce()).toThrow(LighterSignatureError);
    expect(src.lengths.length).toBeLessThanOrEqual(16);
  });

  test('repeated calls do not repeat, on the real platform CSPRNG', () => {
    const seen = new Set<bigint>();
    for (let i = 0; i < 64; i += 1) {
      const k = randomNonce();
      expect(k).toBeGreaterThanOrEqual(1n);
      expect(k).toBeLessThan(N);
      seen.add(k);
    }
    expect(seen.size).toBe(64);
  });
});

/* ----------------------------------------------------------------- dispatch */

describe('chooseNonce dispatch', () => {
  const sk = new Uint8Array(40).map((_, i) => i + 2);
  const msg = new Uint8Array(40).map((_, i) => 0x40 + i);

  test('hedged mode does NOT throw when there is no CSPRNG — that is the point of hedging', () => {
    setCrypto(undefined);
    const k = chooseNonce(sk, msg, 'hedged');
    expect(k).toBe(deriveNonceHedged(sk, msg, ZERO_ENTROPY));
    expect(k).toBeGreaterThanOrEqual(1n);
    expect(k).toBeLessThan(N);

    setCrypto({});
    expect(chooseNonce(sk, msg)).toBe(k);
  });

  test('the default mode is hedged', () => {
    setCrypto(undefined);
    expect(chooseNonce(sk, msg)).toBe(chooseNonce(sk, msg, 'hedged'));
  });

  test('random mode routes to randomNonce', () => {
    const src = recordingSource((b) => {
      b.fill(0);
      b[0] = 42;
    });
    setCrypto(src.crypto);
    expect(chooseNonce(sk, msg, 'random')).toBe(42n);
    expect(src.lengths).toEqual([64]);
  });

  test('random mode throws without a CSPRNG, unlike hedged mode', () => {
    setCrypto(undefined);
    expect(() => chooseNonce(sk, msg, 'random')).toThrow(LighterSignatureError);
    expect(() => chooseNonce(sk, msg, 'hedged')).not.toThrow();
  });

  test('an explicit bigint is reduced mod n, not range-checked — the vector seam', () => {
    expect(chooseNonce(sk, msg, 1n)).toBe(1n);
    expect(chooseNonce(sk, msg, N - 1n)).toBe(N - 1n);
    expect(chooseNonce(sk, msg, N + 5n)).toBe(5n);
    expect(chooseNonce(sk, msg, -1n)).toBe(N - 1n);
    expect(chooseNonce(sk, msg, (1n << 400n) + 3n)).toBe(modN((1n << 400n) + 3n));
  });

  test('an explicit bigint uses no randomness at all', () => {
    setCrypto(undefined);
    expect(chooseNonce(sk, msg, 12345n)).toBe(12345n);
  });

  test('an explicit zero nonce is rejected — k = 0 publishes s = -e*sk', () => {
    expect(() => chooseNonce(sk, msg, 0n)).toThrow(LighterSignatureError);
    expect(() => chooseNonce(sk, msg, N)).toThrow(LighterSignatureError);
    expect(() => chooseNonce(sk, msg, -N)).toThrow(LighterSignatureError);
  });

  test('an unknown mode string is rejected rather than silently treated as hedged', () => {
    expect(() => chooseNonce(sk, msg, 'rfc6979' as unknown as NonceOption)).toThrow(
      LighterSignatureError,
    );
  });

  test('length errors are reported for every argument, in both entry points', () => {
    const short = new Uint8Array(39);
    const long = new Uint8Array(41);
    expect(() => deriveNonceHedged(short, msg, ZERO_ENTROPY)).toThrow(LighterSignatureError);
    expect(() => deriveNonceHedged(long, msg, ZERO_ENTROPY)).toThrow(LighterSignatureError);
    expect(() => deriveNonceHedged(sk, short, ZERO_ENTROPY)).toThrow(LighterSignatureError);
    expect(() => deriveNonceHedged(sk, msg, new Uint8Array(31))).toThrow(LighterSignatureError);
    expect(() => deriveNonceHedged(sk, msg, new Uint8Array(33))).toThrow(LighterSignatureError);
    // An empty entropy buffer is the one a caller passes forever without noticing.
    expect(() => deriveNonceHedged(sk, msg, new Uint8Array(0))).toThrow(LighterSignatureError);
    setCrypto(undefined);
    expect(() => chooseNonce(short, msg)).toThrow(LighterSignatureError);
    expect(() => chooseNonce(sk, long)).toThrow(LighterSignatureError);
  });
});

/* ------------------------------------------------- diagnostics and purity */

describe('diagnostics never carry secrets', () => {
  test('no thrown message contains key, message, entropy or nonce material', () => {
    // Recognisable byte patterns: if any of them appears in a message, something is being echoed.
    const sk = new Uint8Array(40).fill(0xab);
    const msg = new Uint8Array(41).fill(0xcd);
    const entropy = new Uint8Array(33).fill(0xef);
    const secrets = ['abababab', 'cdcdcdcd', 'efefefef', '171', '205', '239'];

    const messages: string[] = [];
    const collect = (fn: () => unknown): void => {
      try {
        fn();
      } catch (e) {
        messages.push(String((e as Error).message));
      }
    };

    collect(() => deriveNonceHedged(sk, msg, new Uint8Array(32)));
    collect(() => deriveNonceHedged(new Uint8Array(39), new Uint8Array(40), new Uint8Array(32)));
    collect(() => deriveNonceHedged(sk, new Uint8Array(40), entropy));
    collect(() => chooseNonce(sk, new Uint8Array(40), 0n));
    collect(() => chooseNonce(sk, new Uint8Array(40), N));
    setCrypto(undefined);
    collect(() => randomNonce());

    expect(messages.length).toBe(6);
    for (const m of messages) {
      for (const secret of secrets) expect(m.includes(secret)).toBe(false);
      expect(m.length).toBeLessThan(200);
    }
  });

  test('an explicit-nonce rejection does not echo the nonce', () => {
    try {
      chooseNonce(new Uint8Array(40), new Uint8Array(40), N * 3n);
      throw new Error('expected a rejection');
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('3');
    }
  });
});

describe('module-scope purity', () => {
  test('the source touches no Node built-in and no module-scope randomness', async () => {
    const src = await readFile(NONCE_SRC_URL, 'utf8');
    // The purity gate from the issue, run as a test so it cannot rot.
    expect(/\bnode:/.test(src)).toBe(false);
    expect(/\bBuffer\b/.test(src)).toBe(false);
    expect(/\bprocess\./.test(src)).toBe(false);
    expect(/\brequire\(/.test(src)).toBe(false);

    // No top-level statement mentions getRandomValues: every reference is indented (inside a
    // function body, an interface body, or a doc comment). A module-scope call would start at
    // column 0 or sit in a top-level `const`.
    const topLevel = src
      .split('\n')
      .filter((line) => /^[^\s/*].*getRandomValues/.test(line));
    expect(topLevel).toEqual([]);
    expect(/^(?:const|let|var)\b[^\n]*getRandomValues/m.test(src)).toBe(false);
  });

  test('importing the module performs no randomness call at all', () => {
    // Cannot be observed in-process — this module is already loaded — so it runs in a subprocess
    // whose `globalThis.crypto` throws on any property access. Cloudflare Workers forbids randomness
    // in the isolate's global scope; a module-scope draw makes the whole SDK fail to load there.
    const url = NONCE_SRC_URL.href;
    const code = [
      "Object.defineProperty(globalThis, 'crypto', {",
      "  value: new Proxy({}, { get() { throw new Error('module-scope randomness'); } }),",
      '  configurable: true,',
      '});',
      `const m = await import(${JSON.stringify(url)});`,
      "if (typeof m.chooseNonce !== 'function') throw new Error('bad module shape');",
      "console.log('IMPORTED-CLEAN');",
    ].join('\n');

    const proc = Bun.spawnSync(['bun', '-e', code]);
    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(`${stdout}${stderr}`).toContain('IMPORTED-CLEAN');
    expect(proc.exitCode).toBe(0);
  });
});
