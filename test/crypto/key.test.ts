/**
 * `ApiKey` — key import, key generation, and signing with a derived nonce.
 *
 * `schnorr.test.ts` covers the deterministic core against the vectors. This file covers the parts
 * only `ApiKey` has:
 *
 * 1. **Import** — 40 bytes, bare hex, `0x` hex; and the four refusals (39 bytes, 41 bytes, non-hex,
 *    and a key that reduces to zero, which includes both 40 zero bytes and the encoding of `n`).
 * 2. **The vector seam** — `sign(m, { nonce: k })` reproduces all 16 pinned signatures byte for
 *    byte, which is what proves the derived-nonce path and the pinned-nonce path are the same code.
 * 3. **Round trips** — 50 seeded `(sk, m)` pairs under the default hedged nonce, then a full
 *    single-bit sweep of the signature, the message and the public key, all of which must fail.
 * 4. **Canonicality** — the bytes and the two hex forms, including a deliberately non-canonical
 *    private key and a non-canonical message encoding, which must produce the same nonce as its
 *    canonical twin.
 * 5. **Generation** — uniform in `[1, n)`, and a hard failure when no CSPRNG exists.
 * 6. **Hygiene** — `sign` is synchronous, and no error message anywhere carries key material.
 *
 * The randomness stubs install and remove `globalThis.crypto` around the tests that need them, so
 * "no CSPRNG present" and "a deterministic CSPRNG" are both exercised in-process.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  type Fp5,
  fp5FromBytes,
  fp5FromLimbs,
  fp5ToBytes,
} from "../../src/crypto/field/fp5.js";
import { ApiKey } from "../../src/crypto/key.js";
import { type Scalar, N, modN, scalarFromBytes, scalarToBytes } from "../../src/crypto/scalar.js";
import { HASH_BYTES, SIGNATURE_BYTES, verify } from "../../src/crypto/schnorr.js";
import { LighterSignatureError } from "../../src/errors.js";
import { bytesToHex, hexToBytes } from "../../src/util/bytes.js";

const KEY_SRC_URL = new URL("../../src/crypto/key.ts", import.meta.url);

interface SchnorrVectors {
  readonly cases: readonly {
    readonly privateKeyLeHex: string;
    readonly publicKeyLeHex: string;
    readonly hashedMessageLeHex: string;
    readonly nonceKLeHex: string;
    readonly signatureBytesHex: string;
  }[];
}

const vectorsUrl = new URL("../../conformance/vectors/schnorr.json", import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, "utf8")) as SchnorrVectors;

const firstCase = vectors.cases[0];
if (firstCase === undefined) throw new Error("schnorr.json has no cases");

/* --------------------------------------------------- helpers */

const MASK64: bigint = (1n << 64n) - 1n;

/** splitmix64 — a seeded, portable PRNG, so every property run is reproducible on every machine. */
function splitmix64(seed: bigint): () => bigint {
  let s: bigint = seed & MASK64;
  return (): bigint => {
    s = (s + 0x9e37_79b9_7f4a_7c15n) & MASK64;
    let z: bigint = s;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK64;
    return z ^ (z >> 31n);
  };
}

function randomBytes40(next: () => bigint): Uint8Array {
  const out: Uint8Array = new Uint8Array(40);
  for (let limb = 0; limb < 5; limb += 1) {
    let v: bigint = next();
    for (let i = 0; i < 8; i += 1) {
      out[limb * 8 + i] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
  return out;
}

/** A copy of `b` with bit `bit` (little-endian within each byte) flipped. */
function flipBit(b: Uint8Array, bit: number): Uint8Array {
  const out: Uint8Array = b.slice();
  const index: number = bit >> 3;
  out[index] = (out[index] ?? 0) ^ (1 << (bit & 7));
  return out;
}

/* --------------------------------------------------- randomness stub plumbing */

const ORIGINAL_CRYPTO = Object.getOwnPropertyDescriptor(globalThis, "crypto");

/** Install an object as `globalThis.crypto`; `undefined` removes it entirely. */
function setCrypto(value: unknown): void {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, "crypto");
    return;
  }
  Object.defineProperty(globalThis, "crypto", { value, configurable: true, writable: true });
}

function restoreCrypto(): void {
  if (ORIGINAL_CRYPTO === undefined) {
    Reflect.deleteProperty(globalThis, "crypto");
    return;
  }
  Object.defineProperty(globalThis, "crypto", ORIGINAL_CRYPTO);
}

/** A deterministic stand-in for the platform CSPRNG: counts calls, fills from a counter. */
function countingSource(): {
  calls: () => number;
  crypto: { getRandomValues: (b: Uint8Array) => Uint8Array };
} {
  let calls = 0;
  return {
    calls: () => calls,
    crypto: {
      getRandomValues(b: Uint8Array): Uint8Array {
        calls += 1;
        for (let i = 0; i < b.length; i += 1) b[i] = (i * 7 + calls * 31) & 0xff;
        return b;
      },
    },
  };
}

afterEach(restoreCrypto);

/* --------------------------------------------------- import */

describe("ApiKey.fromPrivateKey", () => {
  test("accepts 40 bytes, bare hex and 0x hex — all three give the same key", () => {
    const bytes: Uint8Array = hexToBytes(firstCase.privateKeyLeHex);
    const a: ApiKey = ApiKey.fromPrivateKey(bytes);
    const b: ApiKey = ApiKey.fromPrivateKey(firstCase.privateKeyLeHex);
    const c: ApiKey = ApiKey.fromPrivateKey(`0x${firstCase.privateKeyLeHex}`);
    const d: ApiKey = ApiKey.fromPrivateKey(`0X${firstCase.privateKeyLeHex.toUpperCase()}`);
    for (const k of [a, b, c, d]) {
      expect(bytesToHex(k.privateKeyBytes)).toBe(firstCase.privateKeyLeHex);
      expect(bytesToHex(k.publicKeyBytes)).toBe(firstCase.publicKeyLeHex);
    }
  });

  test("derives the pinned public key for all 16 vector keys", () => {
    for (const c of vectors.cases) {
      const key: ApiKey = ApiKey.fromPrivateKey(c.privateKeyLeHex);
      expect(bytesToHex(key.publicKeyBytes)).toBe(c.publicKeyLeHex);
    }
  });

  test("rejects a wrong byte length", () => {
    expect(() => ApiKey.fromPrivateKey(new Uint8Array(39))).toThrow(LighterSignatureError);
    expect(() => ApiKey.fromPrivateKey(new Uint8Array(41))).toThrow(LighterSignatureError);
    expect(() => ApiKey.fromPrivateKey(new Uint8Array(0))).toThrow(LighterSignatureError);
  });

  test("rejects a wrong hex length", () => {
    expect(() => ApiKey.fromPrivateKey("00".repeat(39))).toThrow(LighterSignatureError);
    expect(() => ApiKey.fromPrivateKey("00".repeat(41))).toThrow(LighterSignatureError);
    expect(() => ApiKey.fromPrivateKey("")).toThrow(LighterSignatureError);
  });

  test("rejects a non-hex string", () => {
    const bad: string = `zz${firstCase.privateKeyLeHex.slice(2)}`;
    expect(bad.length).toBe(80);
    expect(() => ApiKey.fromPrivateKey(bad)).toThrow(LighterSignatureError);
    expect(() => ApiKey.fromPrivateKey("0x".padEnd(82, "g"))).toThrow(LighterSignatureError);
  });

  test("rejects a key that is zero mod n", () => {
    //  Both spellings: 40 zero bytes, and the 40-byte encoding of n itself, which reduces to zero.
    expect(() => ApiKey.fromPrivateKey(new Uint8Array(40))).toThrow(LighterSignatureError);
    const nBytes: Uint8Array = new Uint8Array(40);
    let v: bigint = N;
    for (let i = 0; i < 40; i += 1) {
      nBytes[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    expect(scalarFromBytes(nBytes)).toBe(0n);
    expect(() => ApiKey.fromPrivateKey(nBytes)).toThrow(LighterSignatureError);
    expect(() => ApiKey.fromPrivateKey(bytesToHex(nBytes))).toThrow(LighterSignatureError);
  });

  test("a non-canonical private key is reduced, and the accessors are canonical", () => {
    const sk: Scalar = scalarFromBytes(hexToBytes(firstCase.privateKeyLeHex));
    const shifted: Uint8Array = new Uint8Array(40);
    let v: bigint = sk + N; //  still under 2^320, so it round-trips as raw bytes
    for (let i = 0; i < 40; i += 1) {
      shifted[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    expect(bytesToHex(shifted)).not.toBe(firstCase.privateKeyLeHex);

    const key: ApiKey = ApiKey.fromPrivateKey(shifted);
    expect(bytesToHex(key.privateKeyBytes)).toBe(firstCase.privateKeyLeHex);
    expect(bytesToHex(key.publicKeyBytes)).toBe(firstCase.publicKeyLeHex);
  });

  test("the byte accessors hand out copies, so a caller cannot corrupt the key", () => {
    const key: ApiKey = ApiKey.fromPrivateKey(firstCase.privateKeyLeHex);
    const taken: Uint8Array = key.privateKeyBytes;
    taken.fill(0);
    expect(bytesToHex(key.privateKeyBytes)).toBe(firstCase.privateKeyLeHex);

    const pk: Uint8Array = key.publicKeyBytes;
    pk.fill(0);
    expect(bytesToHex(key.publicKeyBytes)).toBe(firstCase.publicKeyLeHex);
  });
});

describe("hex accessors", () => {
  test("0x-prefixed, lowercase, 82 characters", () => {
    const key: ApiKey = ApiKey.fromPrivateKey(firstCase.privateKeyLeHex.toUpperCase());
    for (const hex of [key.privateKeyHex, key.publicKeyHex]) {
      expect(hex.length).toBe(82);
      expect(hex.startsWith("0x")).toBe(true);
      expect(hex).toBe(hex.toLowerCase());
      expect(/^0x[0-9a-f]{80}$/.test(hex)).toBe(true);
    }
    expect(key.privateKeyHex).toBe(`0x${firstCase.privateKeyLeHex}`);
    expect(key.publicKeyHex).toBe(`0x${firstCase.publicKeyLeHex}`);
  });
});

/* --------------------------------------------------- signing */

describe("sign", () => {
  test("an explicit nonce reproduces all 16 pinned signatures exactly", () => {
    for (const c of vectors.cases) {
      const key: ApiKey = ApiKey.fromPrivateKey(c.privateKeyLeHex);
      const k: Scalar = scalarFromBytes(hexToBytes(c.nonceKLeHex));
      const sig: Uint8Array = key.sign(hexToBytes(c.hashedMessageLeHex), { nonce: k });
      expect(bytesToHex(sig)).toBe(c.signatureBytesHex);
    }
  });

  test("is synchronous: the return value is a Uint8Array, not a Promise", () => {
    const key: ApiKey = ApiKey.fromPrivateKey(firstCase.privateKeyLeHex);
    const sig: unknown = key.sign(hexToBytes(firstCase.hashedMessageLeHex));
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig).not.toBeInstanceOf(Promise);
    expect((sig as { then?: unknown }).then).toBeUndefined();
    expect((sig as Uint8Array).length).toBe(SIGNATURE_BYTES);
  });

  test("rejects a message that is not 40 bytes", () => {
    const key: ApiKey = ApiKey.fromPrivateKey(firstCase.privateKeyLeHex);
    expect(() => key.sign(new Uint8Array(39))).toThrow(LighterSignatureError);
    expect(() => key.sign(new Uint8Array(41))).toThrow(LighterSignatureError);
    expect(() => key.sign(new Uint8Array(0))).toThrow(LighterSignatureError);
  });

  test("rejects an explicit nonce of zero mod n", () => {
    const key: ApiKey = ApiKey.fromPrivateKey(firstCase.privateKeyLeHex);
    const m: Uint8Array = hexToBytes(firstCase.hashedMessageLeHex);
    expect(() => key.sign(m, { nonce: 0n })).toThrow(LighterSignatureError);
    expect(() => key.sign(m, { nonce: N })).toThrow(LighterSignatureError);
  });

  test("'random' produces a different signature each call, and every one verifies", () => {
    const key: ApiKey = ApiKey.fromPrivateKey(firstCase.privateKeyLeHex);
    const m: Uint8Array = hexToBytes(firstCase.hashedMessageLeHex);
    const seen: Set<string> = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      const sig: Uint8Array = key.sign(m, { nonce: "random" });
      expect(verify(key.publicKeyBytes, m, sig)).toBe(true);
      seen.add(bytesToHex(sig));
    }
    expect(seen.size).toBe(8);
  });

  test("'random' throws when there is no CSPRNG; 'hedged' does not", () => {
    const key: ApiKey = ApiKey.fromPrivateKey(firstCase.privateKeyLeHex);
    const m: Uint8Array = hexToBytes(firstCase.hashedMessageLeHex);
    setCrypto(undefined);
    expect(() => key.sign(m, { nonce: "random" })).toThrow(LighterSignatureError);
    //  The hedge does not depend on the RNG — that is the entire point of the construction.
    const sig: Uint8Array = key.sign(m);
    expect(verify(key.publicKeyBytes, m, sig)).toBe(true);
  });

  test("the default is hedged: the same message signs differently across calls, with entropy", () => {
    const key: ApiKey = ApiKey.fromPrivateKey(firstCase.privateKeyLeHex);
    const m: Uint8Array = hexToBytes(firstCase.hashedMessageLeHex);
    const src = countingSource();
    setCrypto(src.crypto);
    const a: string = bytesToHex(key.sign(m));
    const b: string = bytesToHex(key.sign(m));
    expect(src.calls()).toBe(2); //  drawn per call, never at module scope
    expect(a).not.toBe(b);
  });

  test("a non-canonical message encoding produces the same nonce as its canonical twin", () => {
    //  The parse is reducing and the re-encode is canonical, so both spellings hash to one nonce.
    //  If they did not, one message would sign under two nonces over the same challenge — the
    //  nonce-reuse failure with extra steps.
    const key: ApiKey = ApiKey.fromPrivateKey(firstCase.privateKeyLeHex);
    //  A message with a small leading coefficient, so that `c + p` still fits in 64 bits. The
    //  vectors' hashes do not, which is itself the reason a hand-built element is used here.
    const canonical: Uint8Array = fp5ToBytes(fp5FromLimbs([1n, 2n, 3n, 4n, 5n]));

    const m: Fp5 = fp5FromBytes(canonical);
    const shifted: Uint8Array = canonical.slice();
    const view: DataView = new DataView(shifted.buffer);
    //  Limb 0 + p: a different encoding of the same field element, which the reducing parser
    //  accepts and the canonical encoder normalises away.
    view.setBigUint64(0, m[0] + 18_446_744_069_414_584_321n, true);
    expect(bytesToHex(shifted)).not.toBe(bytesToHex(canonical));
    expect(bytesToHex(fp5ToBytes(fp5FromBytes(shifted)))).toBe(bytesToHex(canonical));

    //  A deterministic CSPRNG stub makes the hedged derivation reproducible.
    setCrypto(countingSource().crypto);
    const a: string = bytesToHex(key.sign(canonical));
    setCrypto(countingSource().crypto);
    const b: string = bytesToHex(key.sign(shifted));
    expect(a).toBe(b);
    expect(verify(key.publicKeyBytes, canonical, hexToBytes(a))).toBe(true);
  });
});

/* --------------------------------------------------- round trips */

describe("round trip under the default nonce", () => {
  test("50 seeded (sk, m) pairs sign and verify", () => {
    const next = splitmix64(0x51_9e_d5_ee_d0_00_00_01n);
    for (let i = 0; i < 50; i += 1) {
      const skBytes: Uint8Array = randomBytes40(next);
      if (scalarFromBytes(skBytes) === 0n) continue;
      const key: ApiKey = ApiKey.fromPrivateKey(skBytes);
      const m: Uint8Array = fp5ToBytes(fp5FromBytes(randomBytes40(next)));
      const sig: Uint8Array = key.sign(m);
      expect(sig.length).toBe(SIGNATURE_BYTES);
      expect(verify(key.publicKeyBytes, m, sig)).toBe(true);
      //  A different key never verifies this signature.
      expect(verify(ApiKey.fromPrivateKey(randomBytes40(next)).publicKeyBytes, m, sig)).toBe(false);
    }
  });

  test("flipping any single bit of the signature breaks it — all 640", () => {
    const key: ApiKey = ApiKey.fromPrivateKey(firstCase.privateKeyLeHex);
    const m: Uint8Array = hexToBytes(firstCase.hashedMessageLeHex);
    const sig: Uint8Array = key.sign(m);
    expect(verify(key.publicKeyBytes, m, sig)).toBe(true);
    for (let bit = 0; bit < SIGNATURE_BYTES * 8; bit += 1) {
      expect(verify(key.publicKeyBytes, m, flipBit(sig, bit))).toBe(false);
    }
  });

  test("flipping any single bit of the message breaks it — all 320", () => {
    const key: ApiKey = ApiKey.fromPrivateKey(firstCase.privateKeyLeHex);
    const m: Uint8Array = hexToBytes(firstCase.hashedMessageLeHex);
    const sig: Uint8Array = key.sign(m);
    for (let bit = 0; bit < HASH_BYTES * 8; bit += 1) {
      expect(verify(key.publicKeyBytes, flipBit(m, bit), sig)).toBe(false);
    }
  });

  test("flipping any single bit of the public key breaks it — all 320", () => {
    const key: ApiKey = ApiKey.fromPrivateKey(firstCase.privateKeyLeHex);
    const m: Uint8Array = hexToBytes(firstCase.hashedMessageLeHex);
    const sig: Uint8Array = key.sign(m);
    const pk: Uint8Array = key.publicKeyBytes;
    for (let bit = 0; bit < pk.length * 8; bit += 1) {
      expect(verify(flipBit(pk, bit), m, sig)).toBe(false);
    }
  });
});

/* --------------------------------------------------- generation */

describe("ApiKey.generate", () => {
  test("produces distinct, usable keys in [1, n)", () => {
    const seen: Set<string> = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      const key: ApiKey = ApiKey.generate();
      const sk: Scalar = scalarFromBytes(key.privateKeyBytes);
      expect(sk).toBeGreaterThan(0n);
      expect(sk < N).toBe(true);
      //  Canonical round trip, and the key actually signs.
      expect(bytesToHex(key.privateKeyBytes)).toBe(bytesToHex(scalarToBytes(sk)));
      const m: Uint8Array = hexToBytes(firstCase.hashedMessageLeHex);
      expect(verify(key.publicKeyBytes, m, key.sign(m))).toBe(true);
      seen.add(key.privateKeyHex);
    }
    expect(seen.size).toBe(8);
  });

  test("throws LighterSignatureError when there is no CSPRNG", () => {
    setCrypto(undefined);
    expect(() => ApiKey.generate()).toThrow(LighterSignatureError);
    setCrypto({});
    expect(() => ApiKey.generate()).toThrow(LighterSignatureError);
    setCrypto({ getRandomValues: "not a function" });
    expect(() => ApiKey.generate()).toThrow(LighterSignatureError);
  });

  test("draws 64 bytes, not 40 — a 40-byte draw would bias the low third of the range", () => {
    let requested = 0;
    setCrypto({
      getRandomValues(b: Uint8Array): Uint8Array {
        requested = b.length;
        for (let i = 0; i < b.length; i += 1) b[i] = (i * 13 + 5) & 0xff;
        return b;
      },
    });
    ApiKey.generate();
    expect(requested).toBe(64);
  });
});

/* --------------------------------------------------- hygiene */

describe("hygiene", () => {
  test("no error message carries key material", () => {
    const skHex: string = firstCase.privateKeyLeHex;
    const skBytes: Uint8Array = hexToBytes(skHex);
    const sk: Scalar = scalarFromBytes(skBytes);
    const secrets: readonly string[] = [
      skHex,
      skHex.toUpperCase(),
      sk.toString(),
      sk.toString(16),
      firstCase.nonceKLeHex,
      modN(scalarFromBytes(hexToBytes(firstCase.nonceKLeHex))).toString(),
    ];

    const provoke: readonly (() => unknown)[] = [
      () => ApiKey.fromPrivateKey(skBytes.subarray(0, 39)),
      () => ApiKey.fromPrivateKey(`${skHex}00`),
      () => ApiKey.fromPrivateKey(`zz${skHex.slice(2)}`),
      () => ApiKey.fromPrivateKey(new Uint8Array(40)),
      () => ApiKey.fromPrivateKey(skHex).sign(new Uint8Array(39)),
      () => ApiKey.fromPrivateKey(skHex).sign(hexToBytes(firstCase.hashedMessageLeHex), {
          nonce: 0n,
        }),
      () => {
        setCrypto(undefined);
        return ApiKey.fromPrivateKey(skHex).sign(hexToBytes(firstCase.hashedMessageLeHex), {
          nonce: "random",
        });
      },
      () => {
        setCrypto(undefined);
        return ApiKey.generate();
      },
    ];

    for (const [i, fn] of provoke.entries()) {
      let thrown: unknown;
      try {
        fn();
      } catch (e: unknown) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(LighterSignatureError);
      const message: string = (thrown as Error).message;
      for (const secret of secrets) {
        expect(`${String(i)}:${message}`.includes(secret)).toBe(false);
      }
      expect(message.length).toBeLessThan(240);
      restoreCrypto();
    }
  });

  test("the private key is not reachable through enumeration or JSON", () => {
    const key: ApiKey = ApiKey.fromPrivateKey(firstCase.privateKeyLeHex);
    expect(Object.keys(key)).toEqual([]);
    expect(JSON.stringify(key)).toBe("{}");
    expect(String(key)).not.toContain(firstCase.privateKeyLeHex);
  });

  test("the source touches no Node built-in and never awaits", async () => {
    const src: string = await readFile(KEY_SRC_URL, "utf8");
    expect(/\bnode:/.test(src)).toBe(false);
    expect(/\bBuffer\b/.test(src)).toBe(false);
    expect(/\bprocess\./.test(src)).toBe(false);
    expect(/\brequire\(/.test(src)).toBe(false);
    //  WebCrypto's digest API is async-only on the web platform; touching it would force `sign()`
    //  to return a Promise on exactly the runtimes this SDK targets.
    expect(src.includes("sub" + "tle")).toBe(false);
    expect(/\bawait\b/.test(src)).toBe(false);
    //  Randomness is resolved per call inside `nonce.ts`; this file never reaches for the platform
    //  source itself, and certainly not at module scope, which Cloudflare Workers forbids.
    expect(/getRandomValues\s*\(/.test(src)).toBe(false);
    expect(src.split("\n").filter((line) => /^[^\s/*].*getRandomValues/.test(line))).toEqual([]);
  });
});
