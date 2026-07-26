/**
 * Schnorr signatures over the ECgFp5 group — the top of the crypto stack and the only part of it
 * the rest of the SDK calls directly.
 *
 * ```text
 * sign(m, sk):   k = nonce                                  // src/crypto/nonce.ts
 *                R = [k]G ;  r = encode(R)
 *                e = fromFp5( hashToQuinticExtension([r0..r4, m0..m4]) )
 *                s = (k - e*sk) mod n
 *                signature = s || e                         // 40 + 40 bytes, each little-endian
 *
 * verify(pk, m, sig):  P = decode(pk) ;  reject if P is the neutral element
 *                      R_v = [s]G (+) [e]P ;  r_v = encode(R_v)
 *                      return fromFp5( hashToQuinticExtension([r_v, m]) ) == e
 * ```
 *
 * The message arriving here is **already hashed**: 40 bytes, one `GF(p^5)` element. Nothing in this
 * file hashes a transaction. The reference's signing entry point takes a `hash.Hash` parameter and
 * never uses it; that dead surface is not reproduced.
 *
 * Five things in this file are load-bearing.
 *
 * **1. `s = modN(k - modN(e*sk))`.** JavaScript's `%` follows the sign of the dividend, so
 * `(-1n) % n` is `-1n`, and `k - e*sk` is negative for roughly half of all signatures
 * (`docs/protocol-notes.md` §5.0). A literal `(k - e * sk) % N` yields a negative scalar that
 * serialises to a different, invalid value — while every field, hash and curve operation below is
 * perfectly correct. Every subtraction here goes through {@link modN}.
 *
 * **2. The neutral public key is rejected unconditionally, and {@link verify} has no options
 * parameter** (`docs/decisions.md` D1 — the only critical all three independent reviewers raised).
 * `decodePoint(0)` deliberately succeeds, and the reference's verification does not reject the
 * result, so with the neutral key anyone forges: pick any `s`, compute `R = [s]G`, set
 * `e = challenge(encode(R), m)`. That is a live universal forgery. `docs/ARCHITECTURE.md` §6.4 and
 * `spec/03` §8 D2 both propose an options bag on `verify` carrying a flag that permits the neutral
 * key; both are superseded, because such a flag turns a known forgery into a supported
 * configuration. The flag's name appears nowhere in `src/`, and a grep for it is part of this
 * unit's gate. No legitimate account holds the neutral key.
 *
 * **3. Parsers on this path reduce; they do not reject** (`docs/decisions.md` D3,
 * `protocol-notes.md` §5.2.1). `SigFromBytes` in the reference reduces both halves and its
 * `GF(p^5)` loader checks length only, so the sequencer accepts signatures whose raw bytes encode
 * `s + n`, `e + n`, or both. Rejecting those here would reject signatures the exchange accepts —
 * an interop bug, not extra safety. `conformance/vectors/schnorr.json -> malleable` pins all three
 * as valid, and {@link verify} returns `true` for them. There is deliberately **no** canonicality
 * check on the parsed `s`/`e`; the reference's own such check sits after its reducing parse and is
 * dead code. Encoders, by contrast, are always canonical — the server compares public keys as hex
 * strings, so a non-canonical limb silently fails that comparison.
 *
 * **4. The challenge preimage is exactly ten elements, `r` first**:
 * `[r0, r1, r2, r3, r4, m0, m1, m2, m3, m4]`, coefficient 0 first in each. Swapping `r` and `m`
 * produces a self-consistent signer that verifies against itself and fails every vector.
 *
 * **5. `e` is not truncated.** The reference carries a TODO about narrowing it to 128 bits "in
 * coordination with Rust". Implementing that would be a hard fork of the signature scheme; `e`
 * ranges over the full ~319-bit scalar field.
 *
 * Lengths are exact — public key 40, hashed message 40, signature 80 — with no header, prefix byte,
 * length tag or recovery id. The reference ignores trailing bytes on a scalar parse; this does not.
 * {@link verify} answers `false` rather than throwing for every malformed input, so a 79-byte and an
 * 81-byte signature are both simply invalid.
 *
 * No dependencies and no Node built-ins: `BigInt`, the field layer, the group law and Poseidon2.
 */

import { LighterSignatureError } from "../errors.js";
import type { Fp } from "./field/fp.js";
import { type Fp5, fp5FromBytes, fp5IsZero } from "./field/fp5.js";
import { type CurvePoint, decodePoint, encodePoint, pointIsNeutral } from "./point.js";
import { hashToQuinticExtension } from "./poseidon2/index.js";
import {
  type Scalar,
  SCALAR_BYTES,
  modN,
  scalarFromBytes,
  scalarFromFp5,
  scalarToBytes,
} from "./scalar.js";
import { mulAddG, mulGenerator } from "./scalarmul.js";

// ---------------------------------------------------------------------------------------------
// Wire widths
// ---------------------------------------------------------------------------------------------

/** A signature is 80 bytes: `s` as 40 little-endian bytes, then `e` as 40. Pinned by `signatureBytes`. */
export const SIGNATURE_BYTES: 80 = 80;

/** A public key is one `GF(p^5)` element: 40 bytes. Pinned by `pubKeyBytes`. */
export const PUBKEY_BYTES: 40 = 40;

/** A hashed message is one `GF(p^5)` element: 40 bytes. The message is hashed before it gets here. */
export const HASH_BYTES: 40 = 40;

// ---------------------------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------------------------

/**
 * A signature in its arithmetic form.
 *
 * Both halves are scalars in `[0, n)`; {@link signatureToBytes} is the only wire form. `s` is
 * emitted first — the order is protocol, and reversing it produces 80 bytes that verify against
 * nothing.
 */
export interface Signature {
  readonly s: Scalar;
  readonly e: Scalar;
}

// ---------------------------------------------------------------------------------------------
// Key derivation and challenge
// ---------------------------------------------------------------------------------------------

/**
 * The public key for `sk`: `encode([sk]G)`, one `GF(p^5)` element.
 *
 * `sk` is reduced on entry, so an unreduced `bigint` yields the same key as its canonical twin
 * rather than a different one. `sk ≡ 0 (mod n)` produces the neutral element, which is a key nobody
 * controls and which {@link verify} rejects — `ApiKey` refuses to construct one at all.
 */
export function publicKeyFromPrivateKey(sk: Scalar): Fp5 {
  return encodePoint(mulGenerator(modN(sk)));
}

/**
 * The Schnorr challenge `e = fromFp5(hashToQuinticExtension([r0..r4, m0..m4]))`.
 *
 * Ten elements, `r` first, coefficient 0 first within each. With a sponge rate of 8 that is two
 * absorb blocks, the second overwriting only lanes 0 and 1 — the reference's overwrite-mode,
 * no-padding sponge, which `src/crypto/poseidon2/` implements and 45 rows of `poseidon2.json` pin.
 *
 * The `GF(p^5) -> Z/nZ` step is {@link scalarFromFp5}: coefficient `i` is the `i`-th 64-bit limb,
 * least significant first, then reduced mod `n`.
 */
export function challenge(r: Fp5, m: Fp5): Scalar {
  const preimage: readonly Fp[] = [
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
  ];
  return scalarFromFp5(hashToQuinticExtension(preimage));
}

// ---------------------------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------------------------

/**
 * The deterministic core of signing: everything except where `k` came from.
 *
 * This is the function `conformance/vectors/schnorr.json -> cases[]` replays, with `k` taken from
 * `nonceKLeHex`. It draws no randomness, reads no clock and touches no global state — identical
 * arguments always produce an identical signature. Callers that do not have a `k` should use
 * `ApiKey.sign`, which derives one through `chooseNonce`.
 *
 * @param hashedMsg the 40-byte message hash as a `GF(p^5)` element.
 * @param sk the private key; reduced mod `n` on entry.
 * @param k the nonce; reduced mod `n` on entry, and rejected if that is zero.
 * @throws LighterSignatureError if `k ≡ 0 (mod n)`, which would publish `R = O` and make `s` the
 *         private key up to a known factor. The message never contains key material.
 */
export function signHashed(hashedMsg: Fp5, sk: Scalar, k: Scalar): Signature {
  const nonce: Scalar = modN(k);
  if (nonce === 0n) {
    throw new LighterSignatureError("signHashed: the nonce must not be zero mod n");
  }
  const secret: Scalar = modN(sk);

  const r: Fp5 = encodePoint(mulGenerator(nonce));
  const e: Scalar = challenge(r, hashedMsg);
  //  Both reductions matter: `e * secret` is ~638 bits, and `nonce - (that mod n)` is negative for
  //  roughly half of all messages. See point 1 in the module header.
  const s: Scalar = modN(nonce - modN(e * secret));

  return { s, e };
}

// ---------------------------------------------------------------------------------------------
// Signature codec
// ---------------------------------------------------------------------------------------------

/**
 * Encode as exactly 80 bytes: `s` then `e`, each 40 canonical little-endian bytes.
 *
 * Always canonical, even if a caller assembled a `Signature` from unreduced `bigint`s
 * (`docs/decisions.md` D3).
 */
export function signatureToBytes(sig: Signature): Uint8Array {
  const out: Uint8Array = new Uint8Array(SIGNATURE_BYTES);
  out.set(scalarToBytes(sig.s), 0);
  out.set(scalarToBytes(sig.e), SCALAR_BYTES);
  return out;
}

/**
 * Decode exactly 80 bytes, **reducing** both halves mod `n`.
 *
 * Reducing is the interoperable behaviour, not a lax one: the reference's `SigFromBytes` reduces,
 * so signatures encoding `s + n` or `e + n` are accepted by the sequencer and must be accepted here
 * (`docs/decisions.md` D3, and the `malleable` vectors). Only the length is enforced.
 *
 * @throws LighterSignatureError if the input is not exactly {@link SIGNATURE_BYTES} bytes.
 */
export function signatureFromBytes(b: Uint8Array): Signature {
  if (b.length !== SIGNATURE_BYTES) {
    throw new LighterSignatureError(
      `signatureFromBytes: expected ${String(SIGNATURE_BYTES)} bytes, got ${String(b.length)}`,
    );
  }
  return {
    s: scalarFromBytes(b.subarray(0, SCALAR_BYTES)),
    e: scalarFromBytes(b.subarray(SCALAR_BYTES, SIGNATURE_BYTES)),
  };
}

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

/**
 * Verify a signature. **Never throws, and takes no options** — see point 2 in the module header.
 *
 * Every failure mode is a `false`: a wrong length for any of the three arguments, a public key
 * whose encoding decodes to nothing, the neutral public key, and of course a challenge that does
 * not reproduce. The arity is exactly three, and that is asserted in the test file, because the
 * removed opt-out flag for the neutral key is the one API change here that would be invisible in a
 * passing test suite.
 *
 * @param publicKey exactly {@link PUBKEY_BYTES} bytes, little-endian; non-canonical limbs reduce.
 * @param hashedMessage exactly {@link HASH_BYTES} bytes — already hashed.
 * @param signature exactly {@link SIGNATURE_BYTES} bytes; both halves reduce.
 */
export function verify(
  publicKey: Uint8Array,
  hashedMessage: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (
    publicKey.length !== PUBKEY_BYTES ||
    hashedMessage.length !== HASH_BYTES ||
    signature.length !== SIGNATURE_BYTES
  ) {
    return false;
  }

  try {
    const w: Fp5 = fp5FromBytes(publicKey);
    //  D1. `decodePoint(0)` succeeds and returns the neutral, so this must be checked, not assumed.
    if (fp5IsZero(w)) return false;

    const point: CurvePoint | null = decodePoint(w);
    if (point === null) return false;
    //  Unreachable for a non-zero `w` — decoding yields `U = 1` — and kept because D1 is a security
    //  property, not an optimisation, and the codec is another unit's file.
    if (pointIsNeutral(point)) return false;

    const m: Fp5 = fp5FromBytes(hashedMessage);
    const sig: Signature = signatureFromBytes(signature);

    const rv: Fp5 = encodePoint(mulAddG(point, sig.s, sig.e));
    return challenge(rv, m) === sig.e;
  } catch {
    //  The checks above cover every input this can be handed, so reaching here means a defect in a
    //  layer below. It is still a `false`: a verifier that throws is a verifier callers wrap in a
    //  `try` that swallows more than this one does.
    return false;
  }
}
