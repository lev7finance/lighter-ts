/**
 * The Schnorr signing nonce `k` — the most dangerous forty lines in this package.
 *
 * A signature is `s = k - e*sk (mod n)`. `k` never appears on the wire; only `(s, e)` do, and
 * verification merely reconstructs `R = [s]G + [e]P` and recomputes the challenge. That has one
 * pleasant consequence and one lethal one:
 *
 * - **Pleasant:** any correctly-derived `k` is wire-compatible. We are free to derive it better than
 *   the reference does, at zero interoperability cost. `docs/decisions.md` D2 ratifies exactly that.
 * - **Lethal:** *a broken nonce derivation passes every signature conformance test.* A constant,
 *   biased, endian-swapped or message-independent nonce produces signatures that verify perfectly,
 *   that the sequencer accepts, and that hand the private key to anyone who collects two of them:
 *   from `s1 = k - e1*sk` and `s2 = k - e2*sk`, `sk = (s1 - s2) / (e2 - e1)`. One subtraction and one
 *   inversion. `test/crypto/nonce.test.ts` performs that recovery deliberately, so the failure mode
 *   stays visible rather than theoretical.
 *
 * Nothing outside this module can observe a mistake in it. Its own vectors
 * (`test/crypto/nonce-vectors.json`) and its own tests are the entire safety net.
 *
 * ## The construction: `LighterNonce-P2-v1`
 *
 * Hedged-deterministic. `k` is a PRF of the private key and the message, *mixed with* fresh
 * randomness — never dependent on it:
 *
 * ```text
 * seed = chunk32(sk) ++ chunk32(msg) ++ chunk32(entropy)          # 10 + 10 + 8 = 28 elements
 * h0   = hashToQuinticExtension([TAG0, ...seed])                  # 5 coefficients
 * h1   = hashToQuinticExtension([TAG1, ...seed])
 * v    = sum(h0[i] * 2^(64i)) + 2^320 * sum(h1[i] * 2^(64i))      # ~640 bits
 * k    = modN(v)   (and 1 if that is 0, which happens with probability about 2^-319)
 * ```
 *
 * Every clause is load-bearing:
 *
 * 1. **Determinism first, randomness second.** With a repeating, forked, snapshot-restored or absent
 *    RNG the derivation is still a fresh, unpredictable `k` per message, because `sk` and the message
 *    are in the seed. With a working RNG an attacker who can induce faults still cannot replay a
 *    nonce. The reference draws `k` from `crypto/rand` alone and leaks the key outright when that
 *    fails — silently.
 * 2. **Poseidon2, not SHA-256.** `docs/ARCHITECTURE.md` ADR-10 and `spec/03-crypto-curve-schnorr.md`
 *    §9 specify RFC-6979-style HMAC-SHA-256 and are **superseded by D2**. The argument for a separate
 *    primitive is real, and it loses: a hand-written synchronous SHA-256 is ~150 lines of unvalidated
 *    cryptography on the signing path, and `crypto.subtle.digest` cannot substitute because it is
 *    async while `sign()` is synchronous. Poseidon2 is implemented and densely vector-pinned. There
 *    is deliberately no `src/crypto/sha256.ts`.
 * 3. **Two single-output hashes, not one multi-squeeze.** `hashToQuinticExtension` is pinned by 45
 *    rows of `conformance/vectors/poseidon2.json`; the multi-output squeeze branch of `hashNToM` is
 *    far less exercised by the oracle. The security-critical derivation sits on the well-tested one.
 * 4. **32-bit chunks, not 64-bit limbs.** A 64-bit little-endian limb can exceed `p`, and reducing it
 *    is lossy — two distinct keys, or two distinct messages, could then seed identically and produce
 *    the same `k`. Every 32-bit chunk is below `2^32 < p`, so {@link chunk32} is injective and the
 *    seed determines its inputs exactly.
 * 5. **640 bits before reduction.** `n` is 319 bits, so folding ~640 bits leaves a bias below
 *    `2^-320`. Reducing a 320-bit draw instead would leave roughly one bit of bias — precisely what
 *    lattice attacks consume.
 * 6. **Domain separation by a leading tag.** The Schnorr challenge is
 *    `hashToQuinticExtension([r0..r4, m0..m4])`, ten elements. A nonce seed is 29 elements led by
 *    `TAG0`/`TAG1`, so no nonce preimage can collide with a challenge preimage. Do not "simplify"
 *    this into the challenge's input shape.
 *
 * ## Randomness is per call, never at module scope
 *
 * Cloudflare Workers forbids randomness in the isolate's global scope: a module-level draw from
 * `globalThis.crypto` makes the entire SDK fail to load on the primary target runtime
 * (`docs/protocol-notes.md` §5.1). {@link randomFill} resolves `globalThis.crypto` dynamically, on
 * every call, and nothing caches it. This module has no top-level side effects at all.
 *
 * ## Modes
 *
 * | `NonceOption` | Behaviour | No CSPRNG present |
 * | --- | --- | --- |
 * | `'hedged'` (default) | 32 fresh bytes mixed into the derivation | 32 zero bytes; **does not throw** |
 * | `'random'` | 64 fresh bytes, little-endian, reduced mod `n` | throws `LighterSignatureError` |
 * | `bigint` | `modN(k)`, `0` rejected | n/a — no randomness used |
 *
 * The `bigint` mode is the seam `conformance/vectors/schnorr.json -> cases[].nonceKLeHex` replays.
 * It exists for vectors and for callers who have their own derivation; it is not a default.
 *
 * ## Diagnostics
 *
 * No message raised here contains key material, message material, entropy or a nonce — only lengths
 * and mode names. An error string is the one thing in a signing path that reliably reaches a log
 * aggregator.
 *
 * @see `docs/decisions.md` D2
 * @see `docs/protocol-notes.md` §5.1
 */

import { LighterSignatureError } from "../errors.js";

import { type Fp, fpFromU64 } from "./field/fp.js";
import type { Fp5 } from "./field/fp5.js";
import { hashToQuinticExtension } from "./poseidon2/index.js";
import { modN, type Scalar } from "./scalar.js";

/** How `k` is produced when the caller does not supply one. */
export type NonceMode = "hedged" | "random";

/**
 * What {@link chooseNonce} accepts: a mode, or an explicit `k`.
 *
 * An explicit `bigint` is reduced mod `n` rather than range-checked, matching every other scalar
 * entry point in this SDK (`docs/decisions.md` D3). Zero is the one value that cannot be used —
 * `k = 0` publishes `R = O` and `s = -e*sk`, which is the private key up to a known factor.
 */
export type NonceOption = NonceMode | bigint;

/** Private key width, in bytes: one scalar, five 64-bit limbs. */
const SK_BYTES: 40 = 40;

/** Message-hash width, in bytes: one `GF(p^5)` element. */
const MSG_BYTES: 40 = 40;

/**
 * Entropy width for the hedge, in bytes. Exact — a short array throws.
 *
 * Silently accepting whatever length arrives is how a caller ends up passing an empty buffer
 * forever and never noticing, since the output stays a valid-looking nonce.
 */
const ENTROPY_BYTES: 32 = 32;

/** Bytes drawn in `'random'` mode. 64, not 40 — see {@link randomNonce}. */
const RANDOM_DRAW_BYTES: 64 = 64;

/**
 * Domain-separation tag for the low half: ASCII `"LTNONCE0"` read as a little-endian `u64`.
 *
 * `0x3045434E4F4E544C`, comfortably below `p`, so it is absorbed unreduced.
 */
const TAG0: bigint = 3478260290830619724n;

/** Domain-separation tag for the high half: ASCII `"LTNONCE1"` as a little-endian `u64`. */
const TAG1: bigint = 3550317884868547660n;

/** `2^320`: the shift that places `h1` above `h0` in the 640-bit pre-reduction value. */
const SHIFT_320: bigint = 1n << 320n;

/**
 * Upper bound on redraws in `'random'` mode.
 *
 * A real CSPRNG hits zero with probability about `2^-511`, so this bound is unreachable in practice.
 * It exists because a broken or stubbed source that returns all zeros would otherwise spin forever
 * inside a synchronous signing call, which is a worse failure than an error.
 */
const MAX_RANDOM_DRAWS: 16 = 16;

/** The minimal shape of `globalThis.crypto` this module needs. */
interface RandomSource {
  getRandomValues: (array: Uint8Array) => Uint8Array;
}

/**
 * Derive `k` deterministically from `(skBytes, msgBytes, entropy)` — the `LighterNonce-P2-v1`
 * construction described in the module header.
 *
 * Pure and total: no randomness, no clock, no global state. Identical arguments always produce an
 * identical result, which is what makes `test/crypto/nonce-vectors.json` a meaningful contract.
 *
 * `entropy` may be all zeros, and that path is a first-class one — it is what runs when no CSPRNG
 * exists. The result is still message-bound and still unpredictable without `skBytes`.
 *
 * @param skBytes the private key, exactly {@link SK_BYTES} little-endian bytes.
 * @param msgBytes the message hash, exactly {@link MSG_BYTES} little-endian bytes.
 * @param entropy exactly {@link ENTROPY_BYTES} bytes; all-zero is legal.
 * @returns `k` in `[1, n)`.
 * @throws LighterSignatureError on any wrong input length. The message names lengths only.
 */
export function deriveNonceHedged(
  skBytes: Uint8Array,
  msgBytes: Uint8Array,
  entropy: Uint8Array,
): Scalar {
  requireLength(skBytes, SK_BYTES, "private key");
  requireLength(msgBytes, MSG_BYTES, "message hash");
  requireLength(entropy, ENTROPY_BYTES, "entropy");

  // 1 tag + 10 + 10 + 8 = 29 elements. Built once and re-tagged, so both hashes see byte-identical
  // seed material and the only difference between them is element 0.
  const input: Fp[] = new Array<Fp>(1 + 28);
  input[0] = fpFromU64(TAG0);
  let at = 1;
  at = chunk32Into(input, at, skBytes);
  at = chunk32Into(input, at, msgBytes);
  chunk32Into(input, at, entropy);

  const h0: Fp5 = hashToQuinticExtension(input);
  input[0] = fpFromU64(TAG1);
  const h1: Fp5 = hashToQuinticExtension(input);

  // ~640 bits: h0 in the low 320, h1 in the high 320. Swapping the halves, or assembling either
  // half big-endian, changes every nonce and breaks nothing any other test can see.
  const v: bigint = fp5ToInteger(h0) + SHIFT_320 * fp5ToInteger(h1);

  const k: Scalar = modN(v);
  // Probability about 2^-319. Deterministic by design: retrying with different material here would
  // make the function non-reproducible for one input in 2^319, which is untestable and pointless.
  return k === 0n ? 1n : k;
}

/**
 * Draw `k` uniformly at random: 64 bytes from the platform CSPRNG, little-endian, reduced mod `n`.
 *
 * **64 bytes, not 40.** `n` is about `2^319` and `2^320 / n` is about `2.0`, so reducing a 40-byte
 * draw makes the low half of the range roughly twice as likely as the high half — about one bit of
 * bias, which is exactly the shape lattice attacks consume across a few hundred signatures. A
 * 512-bit draw puts the statistical distance from uniform below `2^-192`.
 *
 * This mode is an explicit opt-out of the hedge: it binds `k` to nothing, so a repeating RNG leaks
 * the private key after two signatures. Prefer {@link deriveNonceHedged}.
 *
 * @throws LighterSignatureError if `globalThis.crypto` exposes no random-values function, or if the
 *         source returns an unusable value {@link MAX_RANDOM_DRAWS} times in a row.
 */
export function randomNonce(): Scalar {
  const fill: ((buf: Uint8Array) => Uint8Array) | null = randomFill();
  if (fill === null) {
    throw new LighterSignatureError(
      "randomNonce: no CSPRNG is available — globalThis.crypto.getRandomValues is not a function; " +
        "use the default hedged nonce mode, which does not require one",
    );
  }

  const buf: Uint8Array = new Uint8Array(RANDOM_DRAW_BYTES);
  for (let attempt = 0; attempt < MAX_RANDOM_DRAWS; attempt += 1) {
    fill(buf);
    const k: Scalar = modN(leToBigInt(buf));
    if (k !== 0n) {
      buf.fill(0);
      return k;
    }
  }
  buf.fill(0);
  throw new LighterSignatureError(
    `randomNonce: the CSPRNG returned an unusable value ${String(MAX_RANDOM_DRAWS)} times in a row`,
  );
}

/**
 * The dispatcher the signer calls. Default mode is `'hedged'`.
 *
 * In `'hedged'` mode 32 fresh bytes are pulled **per call**; if no CSPRNG is present, 32 zero bytes
 * are used and the derivation proceeds. That is not a fallback to be flagged — it is the entire
 * point of a hedged construction. Only `'random'` mode, which has nothing else to lean on, requires
 * a CSPRNG and throws without one.
 *
 * @param skBytes the private key, exactly {@link SK_BYTES} bytes.
 * @param msgBytes the message hash, exactly {@link MSG_BYTES} bytes.
 * @param opt `'hedged'` (default), `'random'`, or an explicit `k`.
 * @returns `k` in `[1, n)`.
 * @throws LighterSignatureError on a bad length, an explicit `k` congruent to zero, an unknown mode,
 *         or `'random'` with no CSPRNG.
 */
export function chooseNonce(
  skBytes: Uint8Array,
  msgBytes: Uint8Array,
  opt: NonceOption = "hedged",
): Scalar {
  if (typeof opt === "bigint") {
    const k: Scalar = modN(opt);
    if (k === 0n) {
      // No value in the message: an explicit nonce is key-equivalent material.
      throw new LighterSignatureError("chooseNonce: an explicit nonce must not be zero mod n");
    }
    return k;
  }

  if (opt === "random") return randomNonce();

  if (opt !== "hedged") {
    throw new LighterSignatureError(
      `chooseNonce: unknown nonce mode ${JSON.stringify(String(opt))}`,
    );
  }

  // Per call, never at module scope — Workers forbids randomness in the global scope. A missing
  // source leaves the buffer zero-filled, which is a supported path, not a degraded one.
  const entropy: Uint8Array = new Uint8Array(ENTROPY_BYTES);
  randomFill()?.(entropy);
  const k: Scalar = deriveNonceHedged(skBytes, msgBytes, entropy);
  entropy.fill(0);
  return k;
}

/**
 * Resolve the platform CSPRNG as a fill function, or `null` if there is none.
 *
 * Looked up through `globalThis` on every call, with no caching: a cached lookup is a module-scope
 * access in disguise once a bundler hoists it, and it would defeat the tests that install and remove
 * a stub source. The runtime `typeof` check is the real gate — the declared type is a claim about
 * a well-formed platform, and this code runs on platforms that do not have one.
 */
function randomFill(): ((buf: Uint8Array) => Uint8Array) | null {
  const global: unknown = (globalThis as { crypto?: unknown }).crypto;
  if (typeof global !== "object" || global === null) return null;
  const source: Partial<RandomSource> = global as Partial<RandomSource>;
  const draw: ((buf: Uint8Array) => Uint8Array) | undefined = source.getRandomValues;
  if (typeof draw !== "function") return null;
  // Re-bound to its owner: WebCrypto's implementation is a real method and throws on a detached
  // `this` in some runtimes.
  return (buf: Uint8Array): Uint8Array => draw.call(source, buf);
}

/**
 * Split `b` into 4-byte little-endian words, writing them into `out` starting at `at`.
 *
 * Injective, which is the whole reason for the 32-bit width: every word is below `2^32 < p`, so
 * absorption reduces nothing and distinct byte strings always seed distinctly. Folding into 64-bit
 * limbs instead would let two distinct keys — or two distinct messages — collide.
 *
 * `b.length` is always a multiple of 4 here (40 and 32 both are), enforced by the callers' length
 * checks.
 *
 * @returns the next free index in `out`.
 */
function chunk32Into(out: Fp[], at: number, b: Uint8Array): number {
  let w = at;
  for (let i = 0; i < b.length; i += 4) {
    // Arithmetic rather than `|`/`<<`: JavaScript's bitwise operators are signed 32-bit, so
    // `b[i+3] << 24` is negative for any high byte >= 0x80. The sum stays well inside Number's
    // safe-integer range.
    const word: number =
      (b[i] ?? 0) +
      (b[i + 1] ?? 0) * 0x100 +
      (b[i + 2] ?? 0) * 0x10000 +
      (b[i + 3] ?? 0) * 0x1000000;
    out[w] = fpFromU64(BigInt(word));
    w += 1;
  }
  return w;
}

/** `sum(a[i] * 2^(64 i))` — coefficient 0 is the least significant limb, as everywhere else here. */
function fp5ToInteger(a: Fp5): bigint {
  let v = 0n;
  for (let i = 4; i >= 0; i -= 1) {
    v = (v << 64n) | (a[i] ?? 0n);
  }
  return v;
}

/** Little-endian bytes to a non-negative `bigint`. */
function leToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i -= 1) {
    v = (v << 8n) | BigInt(b[i] ?? 0);
  }
  return v;
}

/** Exact-length gate. The message carries lengths and a role name, never bytes. */
function requireLength(b: Uint8Array, want: number, what: string): void {
  if (b.length !== want) {
    throw new LighterSignatureError(
      `nonce derivation: ${what} must be exactly ${String(want)} bytes, got ${String(b.length)}`,
    );
  }
}
