/**
 * The scalar field `Z/nZ` of the ECgFp5 group, and its 40-byte little-endian codec.
 *
 * Two number systems in this SDK are five 64-bit limbs wide and confusing them is the classic bug
 * here: the **base field** `GF(p)`, `p = 2^64 - 2^32 + 1` (`src/crypto/field/`), and the **scalar
 * field** `Z/nZ`, where `n` is the 319-bit prime order of the curve group. This module is the whole
 * scalar layer — private keys, both halves of a signature, the signing nonce and the challenge all
 * live in it — and nothing here touches `p`.
 *
 * The five-element arrays in `conformance/vectors/` mean two different things for the same reason.
 * In `curve.json -> scalarCases[].scalar` and `schnorr.json -> sigS`/`sigE` they are little-endian
 * 64-bit limbs of an integer, `sum(limb_i * 2^(64 i))`. In `gfp5.json` and in `schnorr.json ->
 * publicKey`/`hashedMessage` they are `GF(p^5)` polynomial coefficients, `sum(c_i * X^i)`. Same
 * shape, unrelated meaning.
 *
 * Four properties are load-bearing.
 *
 * **1. JavaScript `%` follows the sign of the dividend, and this is the single most likely way to
 * produce a correct-looking implementation that cannot sign** (`docs/protocol-notes.md` §5.0).
 * `(-1n) % n` is `-1n`, not `n - 1`. The signature equation is `s = (k - e*sk) mod n` and
 * `k - e*sk` is negative for roughly half of all signatures, so a literal `(k - e * sk) % N` yields
 * a negative scalar; serialising that through shifts or `BigInt.asUintN(320, ...)` produces a
 * different, invalid scalar — while every field, hash and curve operation is perfectly correct.
 * There is therefore exactly one reduction helper, {@link modN}, and every constructor,
 * subtraction, negation, parser and key reduction routes through it.
 *
 * **2. The decoder reduces and never rejects.** This is an interop decision, not a style preference
 * (`docs/decisions.md` D3): the reference's `SigFromBytes` reduces both halves, so a strict parser
 * rejects signatures the sequencer accepts. `curve.json -> scalarCases` pins four rows with
 * `inputWasInRange: false`. Strictness lives only in {@link scalarFromBytesStrict}, which nothing on
 * the sign or verify path calls.
 *
 * **3. Reduction can require subtracting `n` twice.** 40 bytes hold up to `2^320 - 1` and
 * `2^320 / n` is about `2.99`, so a single conditional `if (v >= N) v -= N` is wrong for the top
 * third of the input range. Use `%`. This differs from the base field, where one conditional
 * subtraction genuinely is exact — do not carry that intuition across.
 *
 * **4. Length is exact.** The reference tolerates inputs longer than 40 bytes and ignores the tail;
 * that behaviour is not reproduced. Anything other than exactly {@link SCALAR_BYTES} bytes is a
 * framing error and throws.
 *
 * No dependencies and no Node built-ins: `BigInt`, `Uint8Array` and `Int32Array` only.
 */

import { LighterSignatureError } from "../errors.js";

import { P } from "./field/constants.js";
import { recodeSignedDigits } from "./field/recode.js";

/**
 * An element of `Z/nZ`.
 *
 * Deliberately **not** a brand: the scalar layer is where raw arithmetic results arrive from the
 * signing equation, and a nominal type would only invite casts at exactly the sites that must
 * reduce. The invariant is `0 <= s < N`, and it is upheld by every function in this module
 * returning `Scalar` — including the ones whose inputs are not trusted to hold it.
 */
export type Scalar = bigint;

/**
 * Order of the ECgFp5 group: prime, 319 bits.
 *
 * ```text
 * hex   = 0x7FFFFFFD800000077FFFFFF1000000167FFFFFE6CFB80639E8885C39D724A09CE80FD996948BFFE1
 * limbs = [0xE80FD996948BFFE1, 0xE8885C39D724A09C, 0x7FFFFFE6CFB80639,
 *          0x7FFFFFF100000016, 0x7FFFFFFD80000007]   // little-endian 64-bit limbs
 * ```
 *
 * The decimal, hexadecimal and limb forms are cross-checked against each other in the test file
 * rather than trusted as a transcription.
 */
export const N: bigint =
  1067993516717146951041484916571792702745057740581727230159139685185762082554198619328292418486241n;

/** Wire width of a scalar: 40 little-endian bytes, i.e. five 64-bit limbs. */
export const SCALAR_BYTES: 40 = 40;

/** Windows per scalar for {@link recodeScalar5}: `ceil(320 / 5)`. Not 33 — see {@link recodeScalar5}. */
const SCALAR_WINDOWS_5: 64 = 64;

/** Window width of {@link recodeScalar5}. */
const WINDOW_5: 5 = 5;

/**
 * Euclidean reduction into `[0, N)` — the function this module exists for.
 *
 * `modN(-1n)` is `N - 1n`. Every path that can produce a negative or oversized intermediate goes
 * through here; see property 1 in the module header for why nothing else will do.
 */
export function modN(x: bigint): Scalar {
  const r: bigint = x % N;
  return r < 0n ? r + N : r;
}

/** `a + b` mod `n`. */
export function scalarAdd(a: Scalar, b: Scalar): Scalar {
  return modN(a + b);
}

/** `a - b` mod `n`. Underflow wraps to `N - 1`, never to `-1`. */
export function scalarSub(a: Scalar, b: Scalar): Scalar {
  return modN(a - b);
}

/** `a * b` mod `n`. A single `%`, per `docs/decisions.md` D4. */
export function scalarMul(a: Scalar, b: Scalar): Scalar {
  return modN(a * b);
}

/** `-a` mod `n`. Zero negates to zero, not to `N`. */
export function scalarNeg(a: Scalar): Scalar {
  return modN(-a);
}

/**
 * Encode as exactly 40 little-endian bytes: byte `8i + j` is byte `j` of limb `i`.
 *
 * Always canonical — the value is reduced on the way out, so a caller that hands over an
 * unreduced `bigint` still gets the bytes the sequencer expects rather than a truncation.
 */
export function scalarToBytes(s: Scalar): Uint8Array {
  const out: Uint8Array = new Uint8Array(SCALAR_BYTES);
  let v: bigint = modN(s);
  for (let i: number = 0; i < SCALAR_BYTES; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Decode exactly 40 little-endian bytes, then **reduce** mod `n`.
 *
 * This is the parser on the sign, verify and key-import paths. It reproduces the reference's
 * `SigFromBytes` semantics, which accept a non-canonical encoding; rejecting one here would reject
 * signatures the sequencer accepts (`docs/decisions.md` D3). Only the length is enforced.
 */
export function scalarFromBytes(b: Uint8Array): Scalar {
  return modN(rawFromBytes(b, "scalarFromBytes"));
}

/**
 * Decode exactly 40 little-endian bytes, rejecting any value `>= N`.
 *
 * Explicit opt-in for user-facing decode APIs. Nothing on the sign or verify path may call this —
 * see {@link scalarFromBytes}.
 */
export function scalarFromBytesStrict(b: Uint8Array): Scalar {
  const v: bigint = rawFromBytes(b, "scalarFromBytesStrict");
  if (v >= N) {
    throw new LighterSignatureError(`scalarFromBytesStrict: ${v} is not a canonical scalar`);
  }
  return v;
}

/**
 * True iff `b` is 40 bytes whose little-endian value is already below `N`.
 *
 * A predicate, so a wrong length is reported as `false` rather than thrown: nothing that is not 40
 * bytes denotes a canonical scalar. Use {@link scalarFromBytesStrict} when the length itself must
 * be diagnosed.
 */
export function scalarIsCanonicalBytes(b: Uint8Array): boolean {
  if (b.length !== SCALAR_BYTES) return false;
  return leToBigInt(b) < N;
}

/**
 * Five canonical `GF(p)` coefficients, `X^0` first — structurally the `Fp5` of
 * `src/crypto/field/fp5.ts`, which is another unit's file and cannot be imported from here without
 * coupling the wave. `Fp5` is assignable to this type, and this module never needs its brand.
 */
export type Fp5Like = readonly [bigint, bigint, bigint, bigint, bigint];

/**
 * Challenge conversion, `GF(p^5) -> Z/nZ`: canonicalize each coefficient, assemble
 * `sum(h_i * 2^(64 i))`, reduce mod `n`.
 *
 * The assembly order is protocol, not convention — coefficient 0 is the least significant limb.
 * Canonicalization is free for values that came out of the field layer, which is always canonical
 * here, but it is applied anyway so that a raw or reference-shaped (partially reduced) coefficient
 * maps to the same scalar rather than to a silently different one.
 */
export function scalarFromFp5(h: Fp5Like): Scalar {
  let v: bigint = 0n;
  for (let i: number = 4; i >= 0; i -= 1) {
    const c: bigint = h[i] ?? 0n;
    const canonical: bigint = c % P;
    v = (v << 64n) | (canonical < 0n ? canonical + P : canonical);
  }
  return modN(v);
}

/**
 * Recode a scalar into **64** signed width-5 digits for windowed scalar multiplication:
 * `sum(digits[i] * 32^i) === s`, each digit in `[-15, 16]`, and `digits[63]` non-negative.
 *
 * The count is 64, not 33. `docs/ARCHITECTURE.md` documents a 33-digit `recodeSigned5`; that is the
 * reference's 161-bit signed helper for the GLV-style split of the optional Weierstrass path, and
 * 33 digits cover only 165 bits. Recoding a real 319-bit key through it truncates silently —
 * `sk = 1, 2, 3` still produce the right public key, so the mistake survives casual testing. Both
 * functions exist; this is the one the signing path uses.
 *
 * `s < n < 2^319` while 64 windows cover 320 bits, so the final carry is always absorbed and the
 * top digit lands in `[0, 16]`.
 */
export function recodeScalar5(s: Scalar): Int32Array {
  return recodeSignedDigits(modN(s), SCALAR_WINDOWS_5, WINDOW_5);
}

/** Little-endian bytes to a non-negative `bigint`. No reduction, no length check. */
function leToBigInt(b: Uint8Array): bigint {
  let v: bigint = 0n;
  for (let i: number = b.length - 1; i >= 0; i -= 1) {
    v = (v << 8n) | BigInt(b[i] ?? 0);
  }
  return v;
}

/** Exact-length gate shared by both decoders. The reference's ignore-the-tail behaviour is not reproduced. */
function rawFromBytes(b: Uint8Array, who: string): bigint {
  if (b.length !== SCALAR_BYTES) {
    throw new LighterSignatureError(`${who}: expected ${SCALAR_BYTES} bytes, got ${b.length}`);
  }
  return leToBigInt(b);
}
