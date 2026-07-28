/**
 * Arithmetic in the Goldilocks base field `GF(p)`, `p = 2^64 - 2^32 + 1`.
 *
 * This is the bottom of the crypto stack: `GF(p^5)`, Poseidon2, ECgFp5 and Schnorr all reduce to
 * the operations below. Three properties are load-bearing.
 *
 * **1. Every {@link Fp} is canonical.** The Go reference stores an element as a raw `uint64` that is
 * only partially reduced — after its add/sub/mul the stored word may sit one `p` above the true
 * residue, and `ToCanonicalUint64` applies the final conditional subtraction on the way out. That is
 * a 64-bit-hardware trick with no analogue under `BigInt`, so this module reduces fully on every
 * operation and the brand asserts `0 <= v < p` everywhere. The divergence is observable and
 * documented: `add(p-1, 1)` stores `18446744069414584321` there and **must** produce `0` here
 * (`conformance/vectors/goldilocks.json` -> `nonCanonicalNotes`). It is safe because every value
 * that escapes the field layer — bytes, equality, point encodings, signatures — passes through
 * canonicalization in the reference too.
 *
 * **2. Reduction is a single `%`.** `docs/decisions.md` D4 measured plain `(a * b) % P` at 2.5-4x
 * *faster* than a hand-folded hi/lo Goldilocks reduction on Bun, Node and Deno (34.6 ns vs 139.5 ns
 * per multiply on Bun). The Go intuition inverts because every folding intermediate is a `BigInt`
 * heap allocation. {@link reduce128} and {@link reduceWide} exist as named functions with documented
 * domains, but their bodies are `x % P`, and there is no conditional-subtraction chain anywhere in
 * this module.
 *
 * **3. JavaScript `%` follows the sign of the dividend.** `(-1n) % P === -1n`, not `P - 1n`. Every
 * subtraction that can go negative fixes up explicitly. This is the same class of bug that silently
 * breaks signing (`docs/protocol-notes.md` §5.0).
 *
 * Truncation is not reduction: `2^64 - 1` reduces to `4294967294` (`2^32 - 2`), not `p - 1`. The
 * two's-complement `int64 -> Fp` mapping that protocol integers need is deliberately **not** here;
 * it lives in the transaction codec.
 *
 * No Node built-ins, no dependencies: `BigInt`, `Uint8Array` and `DataView` only.
 */

import { LighterError, LighterMathError } from "../../errors.js";

import { P, POWER_OF_TWO_GENERATOR, TWO_ADICITY } from "./constants.js";

declare const FpBrand: unique symbol;

/**
 * A canonical element of `GF(p)`: a `bigint` with `0 <= v < p`, always.
 *
 * The brand is nominal — a raw `bigint` is not assignable to `Fp`. Values enter through
 * {@link fpFromU64}, {@link fpFromInt}, a decoder, or an operation on existing elements.
 */
export type Fp = bigint & { readonly [FpBrand]: never };

/** Odd part of `p - 1`, i.e. `(p - 1) >> 32`. The Tonelli-Shanks exponent base. */
const ODD_FACTOR: bigint = (P - 1n) >> BigInt(TWO_ADICITY);

/** `(p - 1) / 2`. Euler's criterion exponent. */
const LEGENDRE_EXPONENT: bigint = (P - 1n) >> 1n;

/** `(ODD_FACTOR - 1) / 2`, the exponent plonky2's square root seeds `w` from. */
const SQRT_SEED_EXPONENT: bigint = (ODD_FACTOR - 1n) >> 1n;

/** Additive identity. */
export const FP_ZERO: Fp = 0n as Fp;
/** Multiplicative identity. */
export const FP_ONE: Fp = 1n as Fp;
/** `2`. */
export const FP_TWO: Fp = 2n as Fp;
/** `p - 1`, the canonical representative of `-1`. */
export const FP_NEG_ONE: Fp = (P - 1n) as Fp;

/**
 * Reduce a 64-bit word into the field.
 *
 * Domain is `[0, 2^64)`; anything outside it is a caller bug and throws rather than silently
 * producing a non-canonical value. Note that this is a reduction, not a truncation:
 * `fpFromU64(2^64 - 1)` is `4294967294`.
 */
export function fpFromU64(v: bigint): Fp {
  if (v < 0n || v > 0xffffffffffffffffn) {
    throw new LighterError("decode", `fpFromU64: ${v} is outside [0, 2^64)`);
  }
  return (v < P ? v : v - P) as Fp;
}

/**
 * Reduce an arbitrary integer into the field, of any sign and any magnitude.
 *
 * Proper Euclidean reduction: `fpFromInt(-1n)` is `p - 1`, not `-1`.
 *
 * This is **not** the protocol's `int64 -> Fp` mapping. A negative protocol integer sign-extends to
 * 64 bits first, so `AccountIndex = -1` becomes `4294967294` rather than `p - 1`; that conversion
 * belongs to the transaction codec.
 */
export function fpFromInt(v: bigint): Fp {
  const r: bigint = v % P;
  return (r < 0n ? r + P : r) as Fp;
}

/** `a + b`. */
export function fpAdd(a: Fp, b: Fp): Fp {
  const s: bigint = a + b;
  return (s >= P ? s - P : s) as Fp;
}

/** `a - b`, fixed up when the difference goes negative. */
export function fpSub(a: Fp, b: Fp): Fp {
  const d: bigint = a - b;
  return (d < 0n ? d + P : d) as Fp;
}

/** `-a`. Zero negates to zero, not to `p`. */
export function fpNeg(a: Fp): Fp {
  return (a === 0n ? 0n : P - a) as Fp;
}

/** `2a`. */
export function fpDouble(a: Fp): Fp {
  const s: bigint = a + a;
  return (s >= P ? s - P : s) as Fp;
}

/** `a * b`. A single `%`, per D4. */
export function fpMul(a: Fp, b: Fp): Fp {
  return ((a * b) % P) as Fp;
}

/** `a^2`. */
export function fpSquare(a: Fp): Fp {
  return ((a * a) % P) as Fp;
}

/** `s + x * y` in one reduction — the fused step Poseidon2's internal layer is written in. */
export function fpMulAcc(s: Fp, x: Fp, y: Fp): Fp {
  return ((s + x * y) % P) as Fp;
}

/**
 * `a^e` for `e >= 0`, by square-and-multiply. `a^0` is `1` for every `a`, zero included.
 *
 * A negative exponent throws rather than implying an inverse: inversion is
 * {@link fpInverse}/{@link fpInverseOrZero}, and silently inverting here would hide a sign bug.
 */
export function fpExp(a: Fp, e: bigint): Fp {
  if (e < 0n) {
    throw new LighterMathError("NOT_REPRESENTABLE", `fpExp: negative exponent ${e}`);
  }
  let result: bigint = 1n;
  let base: bigint = a;
  let k: bigint = e;
  while (k > 0n) {
    if ((k & 1n) === 1n) result = (result * base) % P;
    base = (base * base) % P;
    k >>= 1n;
  }
  return result as Fp;
}

/** `a^(2^n)`, i.e. `n` repeated squarings. `n` must be a non-negative integer. */
export function fpExpPow2(a: Fp, n: number): Fp {
  if (!Number.isInteger(n) || n < 0) {
    throw new LighterMathError("NOT_REPRESENTABLE", `fpExpPow2: invalid squaring count ${n}`);
  }
  let x: bigint = a;
  for (let i: number = 0; i < n; i += 1) x = (x * x) % P;
  return x as Fp;
}

/**
 * `a^(p-2)` by the fixed addition chain — 63 squarings and 9 multiplications, the same shape
 * whatever `a` is, so the iteration count carries no information about the operand.
 *
 * `p - 2 = 0b1111111111111111111111111111111011111111111111111111111111111111`: 31 ones, a zero,
 * then 32 ones. Each step below names the run of ones it has accumulated.
 *
 * The caller guarantees `a != 0`.
 */
function inverseChain(a: bigint): bigint {
  const t2: bigint = ((a * a) % P) * a % P; //                          a^(2^2 - 1)
  const t3: bigint = ((t2 * t2) % P) * a % P; //                        a^(2^3 - 1)
  const t6: bigint = (expPow2Raw(t3, 3) * t3) % P; //                   a^(2^6 - 1)
  const t12: bigint = (expPow2Raw(t6, 6) * t6) % P; //                  a^(2^12 - 1)
  const t24: bigint = (expPow2Raw(t12, 12) * t12) % P; //               a^(2^24 - 1)
  const t30: bigint = (expPow2Raw(t24, 6) * t6) % P; //                 a^(2^30 - 1)
  const t31: bigint = ((t30 * t30) % P) * a % P; //                     a^(2^31 - 1)
  const t63: bigint = (expPow2Raw(t31, 32) * t31) % P; //               31 ones, zero, 31 ones
  return ((t63 * t63) % P) * a % P; //                                  ... trailing one
}

/** Unbranded repeated squaring, for the internals that already hold raw `bigint`s. */
function expPow2Raw(x: bigint, n: number): bigint {
  let acc: bigint = x;
  for (let i: number = 0; i < n; i += 1) acc = (acc * acc) % P;
  return acc;
}

/** Multiplicative inverse. Throws on zero, which has none. */
export function fpInverse(a: Fp): Fp {
  if (a === 0n) {
    throw new LighterMathError("NOT_REPRESENTABLE", "fpInverse: zero has no multiplicative inverse");
  }
  return inverseChain(a) as Fp;
}

/**
 * Multiplicative inverse, with `0 -> 0`.
 *
 * The total variant. `GF(p^5)` inversion and the curve formulas both rely on `0` mapping to `0`
 * rather than throwing, so exceptional inputs do not need a branch at every call site.
 */
export function fpInverseOrZero(a: Fp): Fp {
  return (a === 0n ? 0n : inverseChain(a)) as Fp;
}

/**
 * Invert a whole array with Montgomery's trick: one inversion plus `3n` multiplications instead of
 * `n` inversions.
 *
 * Zeros are permitted and map to zero, so this agrees element-wise with {@link fpInverseOrZero} on
 * every input — including an array that is entirely zeros.
 */
export function fpBatchInverse(xs: readonly Fp[]): Fp[] {
  const n: number = xs.length;
  const out: Fp[] = new Array<Fp>(n).fill(FP_ZERO);
  if (n === 0) return out;

  // prefix[i] = product of all non-zero xs[j] for j < i.
  const prefix: bigint[] = new Array<bigint>(n).fill(1n);
  let acc: bigint = 1n;
  for (let i: number = 0; i < n; i += 1) {
    prefix[i] = acc;
    const x: bigint = xs[i] ?? 0n;
    if (x !== 0n) acc = (acc * x) % P;
  }

  // acc is a product of non-zero residues modulo a prime, so it is itself non-zero.
  let inv: bigint = inverseChain(acc);
  for (let i: number = n - 1; i >= 0; i -= 1) {
    const x: bigint = xs[i] ?? 0n;
    if (x === 0n) continue;
    out[i] = ((inv * (prefix[i] ?? 1n)) % P) as Fp;
    inv = (inv * x) % P;
  }
  return out;
}

/**
 * Euler's criterion. `true` for every square, **including zero** — the reference's `Sqrt(0)` returns
 * `(0, true)` and `goldilocks.json` case 0 pins it.
 */
export function fpIsQuadraticResidue(a: Fp): boolean {
  if (a === 0n) return true;
  return fpExp(a, LEGENDRE_EXPONENT) === 1n;
}

/**
 * Square root, or `null` when `a` is not a square. `fpSqrt(0)` is `0`.
 *
 * Tonelli-Shanks in plonky2's exact formulation, seeded from {@link POWER_OF_TWO_GENERATOR}. Both
 * `r` and `-r` are square roots and the seed decides which one comes back; that choice propagates
 * into `GF(p^5)` roots, curve decompression and public-key derivation, so the algorithm is written
 * out step for step rather than replaced with an equivalent-looking variant.
 */
export function fpSqrt(a: Fp): Fp | null {
  if (a === 0n) return FP_ZERO;
  if (!fpIsQuadraticResidue(a)) return null;

  let z: bigint = POWER_OF_TWO_GENERATOR;
  let w: bigint = fpExp(a, SQRT_SEED_EXPONENT);
  let x: bigint = (w * a) % P;
  let b: bigint = (x * w) % P;
  let v: number = TWO_ADICITY;

  while (b !== 1n) {
    let k: number = 0;
    let b2k: bigint = b;
    while (b2k !== 1n) {
      b2k = (b2k * b2k) % P;
      k += 1;
    }
    const j: number = v - k;
    w = z;
    for (let i: number = 1; i < j; i += 1) w = (w * w) % P;

    z = (w * w) % P;
    b = (b * z) % P;
    x = (x * w) % P;
    v = k;
  }
  return x as Fp;
}

/**
 * Reduce a product of two field elements, domain `[0, 2^128)`.
 *
 * A single `%`. `docs/decisions.md` D4: the hi/lo split with a compare-and-subtract fixup chain that
 * the field spec describes is 2.5-4x *slower* under `BigInt`, measured on three engines. Do not
 * reintroduce it.
 */
export function reduce128(x: bigint): Fp {
  return (x % P) as Fp;
}

/** Reduce a triple-width intermediate, domain `[0, 2^192)`. Also a single `%` — see {@link reduce128}. */
export function reduceWide(x: bigint): Fp {
  return (x % P) as Fp;
}

/** `[1, e, e^2, ..., e^(n-1)]`. Returns an empty array for `n <= 0`. */
export function fpPowers(e: Fp, n: number): Fp[] {
  if (!Number.isInteger(n)) {
    throw new LighterMathError("NOT_REPRESENTABLE", `fpPowers: invalid count ${n}`);
  }
  if (n <= 0) return [];
  const out: Fp[] = new Array<Fp>(n).fill(FP_ONE);
  let acc: bigint = 1n;
  for (let i: number = 1; i < n; i += 1) {
    acc = (acc * e) % P;
    out[i] = acc as Fp;
  }
  return out;
}

/** Encode as 8 little-endian bytes. Canonical by construction, since every {@link Fp} is. */
export function fpToBytes(a: Fp): Uint8Array {
  const out: Uint8Array = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, a, true);
  return out;
}

/**
 * Strict 8-byte little-endian decoder: rejects a wrong length and rejects any word `>= p`.
 *
 * The naming is inverted relative to `GF(p^5)` on purpose (`docs/decisions.md` D3): `fp5FromBytes`
 * *reduces*, because the 40-byte decoder sits on the sign/verify interop path where the reference
 * accepts non-canonical input and a strict parser would reject signatures the sequencer accepts.
 * This 8-byte decoder is not on that path, so it keeps the strict default. The asymmetry is
 * deliberate.
 */
export function fpFromBytes(b: Uint8Array): Fp {
  if (b.length !== 8) {
    throw new LighterError("decode", `fpFromBytes: expected 8 bytes, got ${b.length}`);
  }
  const v: bigint = new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(0, true);
  if (v >= P) {
    throw new LighterError("decode", `fpFromBytes: ${v} is not a canonical field element`);
  }
  return v as Fp;
}

/**
 * 8-byte little-endian decoder that reduces instead of rejecting — the reference's
 * `FromCanonicalLittleEndianBytes` semantics, which perform no range validation at all.
 *
 * The length check stays: a short buffer is a framing error, not a non-canonical value.
 */
export function fpFromBytesUnchecked(b: Uint8Array): Fp {
  if (b.length !== 8) {
    throw new LighterError("decode", `fpFromBytesUnchecked: expected 8 bytes, got ${b.length}`);
  }
  const v: bigint = new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(0, true);
  return (v < P ? v : v - P) as Fp;
}

/** Encode `n` elements as `8n` little-endian bytes. */
export function fpArrayToBytes(es: readonly Fp[]): Uint8Array {
  const out: Uint8Array = new Uint8Array(es.length * 8);
  const view: DataView = new DataView(out.buffer);
  for (let i: number = 0; i < es.length; i += 1) {
    view.setBigUint64(i * 8, es[i] ?? 0n, true);
  }
  return out;
}

/**
 * Split bytes into 8-byte little-endian field elements, right-padding a short final group with
 * zeros.
 *
 * **Errors on any group `>= p` rather than reducing.** That check is load-bearing: the auth-token
 * packer (`docs/protocol-notes.md` §6) packs a UTF-8 message this way and must never silently
 * reduce a chunk. It cannot fire for that message format — ASCII digits and colons never produce a
 * word near `p` — which is exactly why it has to be asserted rather than assumed.
 */
export function fpArrayFromBytes(b: Uint8Array): Fp[] {
  const groups: number = Math.ceil(b.length / 8);
  const out: Fp[] = new Array<Fp>(groups).fill(FP_ZERO);
  for (let g: number = 0; g < groups; g += 1) {
    const off: number = g * 8;
    let v: bigint = 0n;
    for (let j: number = 7; j >= 0; j -= 1) {
      v = (v << 8n) | BigInt(b[off + j] ?? 0);
    }
    if (v >= P) {
      throw new LighterError(
        "decode",
        `fpArrayFromBytes: group ${g} decodes to ${v}, which is not a canonical field element`,
      );
    }
    out[g] = v as Fp;
  }
  return out;
}
