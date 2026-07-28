/**
 * Schnorr signing and verification.
 *
 * Every expected value comes from `conformance/vectors/schnorr.json`, generated from the Go
 * reference with a pinned nonce. The coverage is ordered by what it falsifies:
 *
 * 1. **Widths** — the exported constants against the vector's own `signatureBytes`/`pubKeyBytes`.
 * 2. **All 16 `cases` rows**, each checked at four seams: public-key derivation (limbs *and* bytes),
 *    `hashToQuinticExtension` over the message elements (a wiring check across the Poseidon2 seam,
 *    which is what catches a message hash assembled by a different route), the pinned `(s, e)`, and
 *    the 80 bytes. Then `verify` on the result.
 * 3. **The 3 `negative` rows** — one flipped byte in the signature, in the message, and in the key.
 * 4. **The 3 `malleable` rows**, which must **verify**. See the comment on that test: rejecting them
 *    is an interop bug, not extra safety.
 * 5. **The neutral-key forgery** (`docs/decisions.md` D1), constructed here rather than described,
 *    including a demonstration that a verifier without the check would accept it.
 * 6. **Malformed input** — every wrong length, an undecodable key, an all-`0xff` key: `false`, never
 *    a throw.
 * 7. **Structure** — the challenge preimage's element order, and the sign of `k - e*sk`.
 *
 * `ApiKey`, the default nonce, and the round-trip property runs live in `key.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import type { Fp } from "../../src/crypto/field/fp.js";
import {
  type Fp5,
  FP5_ZERO,
  fp5FromBytes,
  fp5FromLimbs,
  fp5ToBytes,
} from "../../src/crypto/field/fp5.js";
import { NEUTRAL, decodePoint, encodePoint } from "../../src/crypto/point.js";
import { hashToQuinticExtension } from "../../src/crypto/poseidon2/index.js";
import { type Scalar, N, modN, scalarFromBytes, scalarToBytes } from "../../src/crypto/scalar.js";
import { mulAddG, mulGenerator } from "../../src/crypto/scalarmul.js";
import {
  HASH_BYTES,
  PUBKEY_BYTES,
  SIGNATURE_BYTES,
  type Signature,
  challenge,
  publicKeyFromPrivateKey,
  signHashed,
  signatureFromBytes,
  signatureToBytes,
  verify,
} from "../../src/crypto/schnorr.js";
import { LighterSignatureError } from "../../src/errors.js";
import { bytesToHex, hexToBytes } from "../../src/util/bytes.js";

const SCHNORR_SRC_URL = new URL("../../src/crypto/schnorr.ts", import.meta.url);

interface SchnorrVectors {
  readonly signatureBytes: number;
  readonly pubKeyBytes: number;
  readonly cases: readonly {
    readonly privateKeyLeHex: string;
    readonly publicKey: readonly string[];
    readonly publicKeyLeHex: string;
    readonly messageElements: readonly string[];
    readonly hashedMessage: readonly string[];
    readonly hashedMessageLeHex: string;
    readonly nonceKLeHex: string;
    readonly sigS: readonly string[];
    readonly sigE: readonly string[];
    readonly signatureBytesHex: string;
    readonly valid: boolean;
    readonly canonical: boolean;
  }[];
  readonly negative: readonly {
    readonly description: string;
    readonly publicKeyLeHex: string;
    readonly hashedMessageLeHex: string;
    readonly signatureHex: string;
    readonly valid: boolean;
  }[];
  readonly malleable: readonly {
    readonly description: string;
    readonly publicKeyLeHex: string;
    readonly hashedMessageLeHex: string;
    readonly originalSignatureHex: string;
    readonly shiftedSignatureHex: string;
    readonly shiftedRawScalarsInRange: boolean;
    readonly shiftedValidates: boolean;
  }[];
}

const vectorsUrl = new URL("../../conformance/vectors/schnorr.json", import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, "utf8")) as SchnorrVectors;

/* --------------------------------------------------------------- helpers */

const MASK64: bigint = (1n << 64n) - 1n;

/** A scalar as its five little-endian 64-bit limbs, decimal — the form `sigS`/`sigE` use. */
function limbs(s: Scalar): string[] {
  const out: string[] = [];
  let v: bigint = s;
  for (let i = 0; i < 5; i += 1) {
    out.push(String(v & MASK64));
    v >>= 64n;
  }
  return out;
}

/** A `GF(p^5)` element as its five decimal coefficients — the form `publicKey`/`hashedMessage` use. */
function coeffs(a: Fp5): string[] {
  return [String(a[0]), String(a[1]), String(a[2]), String(a[3]), String(a[4])];
}

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

/** A 40-byte little-endian value from the seeded PRNG. */
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

/* --------------------------------------------------------------- widths */

describe("wire widths", () => {
  test("the exported constants match the vector file", () => {
    expect(SIGNATURE_BYTES).toBe(80);
    expect(PUBKEY_BYTES).toBe(40);
    expect(HASH_BYTES).toBe(40);
    expect(vectors.signatureBytes).toBe(SIGNATURE_BYTES);
    expect(vectors.pubKeyBytes).toBe(PUBKEY_BYTES);
  });

  test("the vector file has the coverage this suite assumes", () => {
    expect(vectors.cases.length).toBe(16);
    expect(vectors.negative.length).toBe(3);
    expect(vectors.malleable.length).toBe(3);
  });
});

/* --------------------------------------------------------------- vectors */

describe("conformance: cases", () => {
  vectors.cases.forEach((c, i) => {
    test(`case ${String(i)} (${String(c.messageElements.length)} message elements)`, () => {
      const sk: Scalar = scalarFromBytes(hexToBytes(c.privateKeyLeHex));

      //  1. Key derivation, in both forms. The limbs catch a wrong point; the bytes catch a
      //     non-canonical encoder, which the server would reject as a string comparison.
      const pk: Fp5 = publicKeyFromPrivateKey(sk);
      expect(coeffs(pk)).toEqual([...c.publicKey]);
      expect(bytesToHex(fp5ToBytes(pk))).toBe(c.publicKeyLeHex);

      //  2. The Poseidon2 seam: the message hash this SDK computes must be the one the oracle fed
      //     to the signer, or every signature below would be over a different message.
      const hashed: Fp5 = hashToQuinticExtension(c.messageElements.map((e) => BigInt(e) as Fp));
      expect(coeffs(hashed)).toEqual([...c.hashedMessage]);
      expect(bytesToHex(fp5ToBytes(hashed))).toBe(c.hashedMessageLeHex);

      //  3. The pinned signature, from the pinned nonce.
      const k: Scalar = scalarFromBytes(hexToBytes(c.nonceKLeHex));
      const sig: Signature = signHashed(hashed, sk, k);
      expect(limbs(sig.s)).toEqual([...c.sigS]);
      expect(limbs(sig.e)).toEqual([...c.sigE]);

      //  4. The 80 bytes, s first.
      const bytes: Uint8Array = signatureToBytes(sig);
      expect(bytes.length).toBe(SIGNATURE_BYTES);
      expect(bytesToHex(bytes)).toBe(c.signatureBytesHex);

      //  5. And it verifies.
      expect(
        verify(hexToBytes(c.publicKeyLeHex), hexToBytes(c.hashedMessageLeHex), bytes),
      ).toBe(c.valid);
    });
  });

  test("signing is deterministic given k", () => {
    const c = vectors.cases[0];
    if (c === undefined) throw new Error("no cases");
    const sk: Scalar = scalarFromBytes(hexToBytes(c.privateKeyLeHex));
    const m: Fp5 = fp5FromBytes(hexToBytes(c.hashedMessageLeHex));
    const k: Scalar = scalarFromBytes(hexToBytes(c.nonceKLeHex));
    const a: Uint8Array = signatureToBytes(signHashed(m, sk, k));
    const b: Uint8Array = signatureToBytes(signHashed(m, sk, k));
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });
});

describe("conformance: negative", () => {
  vectors.negative.forEach((n) => {
    test(`${n.description} does not verify`, () => {
      expect(
        verify(
          hexToBytes(n.publicKeyLeHex),
          hexToBytes(n.hashedMessageLeHex),
          hexToBytes(n.signatureHex),
        ),
      ).toBe(n.valid);
      expect(n.valid).toBe(false);
    });
  });
});

describe("conformance: malleable — these MUST verify", () => {
  /*
   * `docs/decisions.md` D3, `docs/protocol-notes.md` §5.2.1.
   *
   * Each row re-encodes `s + n`, `e + n`, or both into the raw 80 bytes. Those bytes are not
   * canonical (`shiftedRawScalarsInRange: false`) and the reference **accepts them anyway**:
   * `SigFromBytes` parses both halves with the reducing scalar decoder, so the sequencer validates
   * them (`shiftedValidates: true`). A strict parser here would therefore reject signatures the
   * exchange accepts — an interop bug, not extra safety, and one that would only surface against
   * live traffic. This is why there is no canonicality check on the parsed `s`/`e`; the reference's
   * own such check sits after its reducing parse and is dead code.
   */
  vectors.malleable.forEach((m) => {
    test(`${m.description}: the shifted signature verifies`, () => {
      expect(m.shiftedRawScalarsInRange).toBe(false);
      expect(m.shiftedValidates).toBe(true);

      const pk: Uint8Array = hexToBytes(m.publicKeyLeHex);
      const msg: Uint8Array = hexToBytes(m.hashedMessageLeHex);
      expect(verify(pk, msg, hexToBytes(m.originalSignatureHex))).toBe(true);
      expect(verify(pk, msg, hexToBytes(m.shiftedSignatureHex))).toBe(true);

      //  The shifted bytes differ from the canonical ones, but parse to the same scalars.
      expect(m.shiftedSignatureHex).not.toBe(m.originalSignatureHex);
      const parsed: Signature = signatureFromBytes(hexToBytes(m.shiftedSignatureHex));
      const original: Signature = signatureFromBytes(hexToBytes(m.originalSignatureHex));
      expect(parsed.s).toBe(original.s);
      expect(parsed.e).toBe(original.e);
      //  ...and re-encoding is canonical, so a round trip normalises rather than preserving.
      expect(bytesToHex(signatureToBytes(parsed))).toBe(m.originalSignatureHex);
    });
  });
});

/* --------------------------------------------------------------- D1: the neutral key */

describe("the neutral public key is rejected unconditionally (D1)", () => {
  const forgery = (): { m: Uint8Array; forged: Uint8Array; s: Scalar; e: Scalar } => {
    //  The universal forgery, constructed exactly as `docs/protocol-notes.md` §5.2.2 describes:
    //  pick any s, compute R = [s]G, and set e = challenge(encode(R), m). No private key involved.
    const m: Uint8Array = hexToBytes(
      vectors.cases[0]?.hashedMessageLeHex ?? "".padEnd(80, "0"),
    );
    const s: Scalar = 0x1234_5678_9abc_def0n;
    const e: Scalar = challenge(encodePoint(mulGenerator(s)), fp5FromBytes(m));
    return { m, forged: signatureToBytes({ s, e }), s, e };
  };

  test("the forgery is live — a verifier without the check would accept it", () => {
    const { m, s, e } = forgery();
    //  This is the reference's behaviour, reproduced here so the risk stays visible: with the
    //  neutral key, [s]G (+) [e]P collapses to [s]G, so the challenge reproduces exactly.
    const rv: Fp5 = encodePoint(mulAddG(NEUTRAL, s, e));
    expect(challenge(rv, fp5FromBytes(m))).toBe(e);
    //  And `decodePoint(0)` deliberately succeeds, which is what makes the key reachable at all.
    expect(decodePoint(FP5_ZERO)).not.toBeNull();
  });

  test("verify rejects it", () => {
    const { m, forged } = forgery();
    expect(verify(new Uint8Array(PUBKEY_BYTES), m, forged)).toBe(false);
  });

  test("verify exposes no options parameter", () => {
    //  The removed `allowNeutralPublicKey` option is the one API change here that a passing test
    //  suite would otherwise hide: an opt-out turns a known universal forgery into a supported
    //  configuration. Arity is the mechanical check.
    expect(verify.length).toBe(3);
  });

  test("the superseded opt-out flag's name appears nowhere under src/", () => {
    //  The issue's D1 gate, run as a test so it cannot rot: `grep -rn <flag> src/` prints nothing.
    //  The name is assembled here rather than written out, so this file does not defeat its own
    //  grep — and neither does any prose in `src/`, which is the point.
    const flag: string = ["allow", "Neutral", "Public", "Key"].join("");
    const proc = Bun.spawnSync(["grep", "-rn", flag, "src/"], {
      cwd: new URL("../../", import.meta.url).pathname,
    });
    const out: string = new TextDecoder().decode(proc.stdout);
    expect(out).toBe("");
  });
});

/* --------------------------------------------------------------- malformed input */

describe("verify never throws", () => {
  const c = vectors.cases[0];
  if (c === undefined) throw new Error("no cases");
  const pk: Uint8Array = hexToBytes(c.publicKeyLeHex);
  const msg: Uint8Array = hexToBytes(c.hashedMessageLeHex);
  const sig: Uint8Array = hexToBytes(c.signatureBytesHex);

  test("wrong public-key length", () => {
    expect(verify(pk.subarray(0, 39), msg, sig)).toBe(false);
    expect(verify(new Uint8Array(41), msg, sig)).toBe(false);
    expect(verify(new Uint8Array(0), msg, sig)).toBe(false);
  });

  test("wrong signature length", () => {
    expect(verify(pk, msg, sig.subarray(0, 79))).toBe(false);
    expect(verify(pk, msg, new Uint8Array(81))).toBe(false);
    expect(verify(pk, msg, new Uint8Array(0))).toBe(false);
  });

  test("wrong message length", () => {
    expect(verify(pk, msg.subarray(0, 39), sig)).toBe(false);
    expect(verify(pk, new Uint8Array(41), sig)).toBe(false);
  });

  test("a public key whose encoding decodes to nothing", () => {
    //  w = 1 is not the encoding of any group element: the discriminant is a non-square.
    const undecodable: Uint8Array = fp5ToBytes(fp5FromLimbs([1n, 0n, 0n, 0n, 0n]));
    expect(decodePoint(fp5FromBytes(undecodable))).toBeNull();
    expect(verify(undecodable, msg, sig)).toBe(false);
  });

  test("an all-0xff public key", () => {
    //  Every limb is above p, so the reducing parser accepts it and it happens to decode. It is
    //  simply the wrong key, and the answer is `false` rather than an exception either way.
    const ff: Uint8Array = new Uint8Array(PUBKEY_BYTES).fill(0xff);
    expect(verify(ff, msg, sig)).toBe(false);
  });

  test("an all-zero signature against a real key", () => {
    expect(verify(pk, msg, new Uint8Array(SIGNATURE_BYTES))).toBe(false);
  });

  test("256 seeded random (key, message, signature) triples are all rejected, none throw", () => {
    const next = splitmix64(0x5c_a1_ab_1e_5e_ed_00_01n);
    for (let i = 0; i < 256; i += 1) {
      const rpk: Uint8Array = randomBytes40(next);
      const rmsg: Uint8Array = randomBytes40(next);
      const rsig: Uint8Array = new Uint8Array(SIGNATURE_BYTES);
      rsig.set(randomBytes40(next), 0);
      rsig.set(randomBytes40(next), 40);
      expect(verify(rpk, rmsg, rsig)).toBe(false);
    }
  });
});

/* --------------------------------------------------------------- structure */

describe("structure", () => {
  test("the challenge preimage is [r, m] and not [m, r]", () => {
    //  Swapping the halves yields a signer that verifies against itself and fails every vector, so
    //  only an explicit asymmetry test names the bug.
    const r: Fp5 = fp5FromLimbs([1n, 2n, 3n, 4n, 5n]);
    const m: Fp5 = fp5FromLimbs([6n, 7n, 8n, 9n, 10n]);
    expect(challenge(r, m)).not.toBe(challenge(m, r));

    //  ...and it is exactly hashToQuinticExtension over the ten elements in that order.
    const expected: Fp5 = hashToQuinticExtension([
      r[0],
      r[1],
      r[2],
      r[3],
      r[4],
      m[0],
      m[1],
      m[2],
      m[3],
      m[4],
    ]);
    let folded = 0n;
    for (let i = 4; i >= 0; i -= 1) folded = (folded << 64n) | (expected[i] ?? 0n);
    expect(challenge(r, m)).toBe(modN(folded));
  });

  test("s is reduced, never negative — the `%`-sign trap", () => {
    //  `k - e*sk` is negative for roughly half of all messages, and JavaScript's `%` would keep the
    //  sign. Over 200 seeded signatures every `s` must land in [0, n).
    const next = splitmix64(0x0bad_c0ff_ee12_3456n);
    let negativeRaw = 0;
    for (let i = 0; i < 200; i += 1) {
      const sk: Scalar = scalarFromBytes(randomBytes40(next));
      const m: Fp5 = fp5FromBytes(randomBytes40(next));
      const k: Scalar = scalarFromBytes(randomBytes40(next));
      if (sk === 0n || k === 0n) continue;
      const sig: Signature = signHashed(m, sk, k);
      expect(sig.s >= 0n).toBe(true);
      expect(sig.s < N).toBe(true);
      expect(sig.e >= 0n).toBe(true);
      expect(sig.e < N).toBe(true);
      if (k - ((sig.e * sk) % N) < 0n) negativeRaw += 1;
      //  The signature equation itself, restated: k = s + e*sk (mod n).
      expect(modN(sig.s + sig.e * sk)).toBe(modN(k));
    }
    //  The trap is only reachable if the naive intermediate really does go negative in this sample.
    expect(negativeRaw).toBeGreaterThan(20);
  });

  test("e is a full-width scalar and is not truncated to 128 bits", () => {
    //  The reference carries a TODO about narrowing e "in coordination with Rust"; implementing it
    //  would be a hard fork of the scheme.
    const wide = vectors.cases.filter((c) => BigInt(c.sigE[4] ?? "0") !== 0n);
    expect(wide.length).toBeGreaterThan(0);
  });

  test("publicKeyFromPrivateKey reduces its input", () => {
    const sk: Scalar = 12_345n;
    expect(coeffs(publicKeyFromPrivateKey(sk))).toEqual(coeffs(publicKeyFromPrivateKey(sk + N)));
  });
});

/* --------------------------------------------------------------- codec */

describe("signature codec", () => {
  test("exactly 80 bytes in, or an error", () => {
    expect(() => signatureFromBytes(new Uint8Array(79))).toThrow(LighterSignatureError);
    expect(() => signatureFromBytes(new Uint8Array(81))).toThrow(LighterSignatureError);
    expect(() => signatureFromBytes(new Uint8Array(0))).toThrow(LighterSignatureError);
  });

  test("s occupies the first 40 bytes and e the last 40", () => {
    const sig: Signature = { s: 7n, e: 9n };
    const bytes: Uint8Array = signatureToBytes(sig);
    expect(bytesToHex(bytes.subarray(0, 40))).toBe(bytesToHex(scalarToBytes(7n)));
    expect(bytesToHex(bytes.subarray(40, 80))).toBe(bytesToHex(scalarToBytes(9n)));
  });

  test("the encoder canonicalises an unreduced Signature", () => {
    const raw: Uint8Array = signatureToBytes({ s: N + 5n, e: N + 6n });
    const canonical: Uint8Array = signatureToBytes({ s: 5n, e: 6n });
    expect(bytesToHex(raw)).toBe(bytesToHex(canonical));
  });

  test("the decoder reduces rather than rejecting", () => {
    const shifted: Uint8Array = new Uint8Array(SIGNATURE_BYTES);
    shifted.set(scalarToBytes(0n), 0);
    //  scalarToBytes canonicalises, so build the non-canonical halves by hand.
    const wide = (v: bigint): Uint8Array => {
      const out = new Uint8Array(40);
      let x = v;
      for (let i = 0; i < 40; i += 1) {
        out[i] = Number(x & 0xffn);
        x >>= 8n;
      }
      return out;
    };
    shifted.set(wide(N + 5n), 0);
    shifted.set(wide(N + 6n), 40);
    const parsed: Signature = signatureFromBytes(shifted);
    expect(parsed.s).toBe(5n);
    expect(parsed.e).toBe(6n);
  });
});

/* --------------------------------------------------------------- hygiene */

describe("hygiene", () => {
  test("signHashed refuses a zero nonce, and says nothing about the key", () => {
    const sk: Scalar = 0xdead_beef_cafe_baben;
    const m: Fp5 = fp5FromLimbs([1n, 2n, 3n, 4n, 5n]);
    try {
      signHashed(m, sk, 0n);
      throw new Error("expected a rejection");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(LighterSignatureError);
      const message: string = (e as Error).message;
      expect(message).not.toContain(sk.toString());
      expect(message).not.toContain(sk.toString(16));
      expect(message.length).toBeLessThan(200);
    }
    //  n itself is zero mod n, so it is refused too.
    expect(() => signHashed(m, sk, N)).toThrow(LighterSignatureError);
  });

  test("the source touches no Node built-in", async () => {
    const src: string = await readFile(SCHNORR_SRC_URL, "utf8");
    expect(/\bnode:/.test(src)).toBe(false);
    expect(/\bBuffer\b/.test(src)).toBe(false);
    expect(/\bprocess\./.test(src)).toBe(false);
    expect(/\brequire\(/.test(src)).toBe(false);
    //  Signing is synchronous end to end: `crypto.subtle` is async-only on the web platform.
    expect(src.includes("subtle")).toBe(false);
    expect(/\basync\b/.test(src)).toBe(false);
  });
});
