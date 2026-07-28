/**
 * {@link ApiKey} — an API key pair and the one object in this SDK that holds secret material.
 *
 * This is the replacement for the Go reference's `KeyManager`. It is deliberately small: parse a
 * private key, expose the derived public key, and sign a 40-byte hashed message. It builds no
 * transactions, talks to no network, and has no lifecycle.
 *
 * ## What it guarantees
 *
 * - **Canonical bytes out.** `privateKeyBytes`, `publicKeyBytes` and the two hex forms are always
 *   the canonical encoding of the reduced value (`docs/decisions.md` D3). This is not cosmetic:
 *   the server compares public keys as hex strings, so a limb left above the modulus silently
 *   fails that comparison while every signature it produces still verifies.
 * - **Reducing input.** A 40-byte key is length-checked exactly and then reduced mod `n`, the same
 *   parse the sign and verify paths use. Only `sk ≡ 0 (mod n)` is refused, because it derives the
 *   neutral public key — a key nobody controls, which `verify` rejects outright (D1).
 * - **Synchronous signing on every runtime.** Nothing here touches WebCrypto's digest API, which is
 *   async-only on the web platform and would force `sign()` to return a `Promise`.
 * - **No key material in any error.** Messages carry lengths and reasons, never bytes.
 * - **No module-scope randomness.** Cloudflare Workers forbids `crypto.getRandomValues` in the
 *   isolate's global scope; every draw here happens inside a call.
 *
 * ## The nonce
 *
 * `sign()` defaults to `'hedged'` — `k` derived from the private key and the message, mixed with
 * fresh randomness (`docs/decisions.md` D2). `'random'` and an explicit `bigint` are available;
 * the explicit form is the seam `conformance/vectors/schnorr.json` replays, and it reproduces a
 * pinned signature exactly.
 *
 * The message is parsed with the reducing `GF(p^5)` parser and **re-encoded canonically** before it
 * reaches the nonce derivation, so a non-canonical encoding of a message yields the same nonce as
 * its canonical twin. Two spellings of one message must never produce two different nonces over the
 * same challenge — that is the nonce-reuse failure with extra steps.
 *
 * A broken nonce derivation passes every test in this file and every conformance vector; the gate
 * for that lives in `src/crypto/nonce.ts` and `test/crypto/nonce.test.ts`.
 *
 * No dependencies and no Node built-ins: `BigInt`, `Uint8Array`, and `globalThis.crypto` resolved
 * per call.
 */

import { LighterSignatureError } from "../errors.js";
import { bytesToHex, hexToBytes } from "../util/bytes.js";
import { type Fp5, fp5FromBytes, fp5ToBytes } from "./field/fp5.js";
import { type NonceOption, chooseNonce, randomNonce } from "./nonce.js";
import { type Scalar, SCALAR_BYTES, scalarFromBytes, scalarToBytes } from "./scalar.js";
import {
  HASH_BYTES,
  type Signature,
  publicKeyFromPrivateKey,
  signHashed,
  signatureToBytes,
} from "./schnorr.js";

/**
 * How `k` is produced when the caller does not supply one.
 *
 * Re-exported from `./nonce.js` rather than redeclared, so the crypto barrel exports one type by
 * this name and not two structurally identical ones.
 */
export type { NonceMode } from "./nonce.js";

/** Private key width: one scalar, 40 little-endian bytes. */
const PRIVATE_KEY_BYTES: 40 = SCALAR_BYTES;

/** Hex characters in a 40-byte value, before the `0x`. */
const PRIVATE_KEY_HEX_CHARS: 80 = 80;

/** Options for {@link ApiKey.sign}. */
export interface SignOptions {
  /**
   * `'hedged'` (the default), `'random'`, or an explicit `k`.
   *
   * An explicit `bigint` is reduced mod `n` and rejected if that is zero. Supplying the same `k`
   * for two different messages recovers the private key from the two signatures — it exists for
   * vectors and for callers with their own derivation, and it is not a default.
   */
  readonly nonce?: NonceOption;
}

/**
 * An API key pair: a scalar private key, its derived public key, and `sign`.
 *
 * Construct with {@link ApiKey.fromPrivateKey} or {@link ApiKey.generate}; the constructor is
 * private so that no instance can exist without a validated key.
 */
export class ApiKey {
  /** The reduced private key. `#`-private: not enumerable, not serialisable, not reachable by cast. */
  readonly #sk: Scalar;

  /** Canonical 40-byte little-endian private key. Never handed out directly — see the getter. */
  readonly #skBytes: Uint8Array;

  /** Canonical 40-byte little-endian public key, `encode([sk]G)`. */
  readonly #pkBytes: Uint8Array;

  private constructor(sk: Scalar) {
    if (sk === 0n) {
      //  Reachable from a caller's bytes, so it is a thrown error rather than an assertion: `sk = 0`
      //  derives the neutral public key, which `verify` rejects and which nobody controls.
      throw new LighterSignatureError(
        "ApiKey: the private key is zero mod n, which derives the neutral public key",
      );
    }
    this.#sk = sk;
    this.#skBytes = scalarToBytes(sk);
    const pk: Fp5 = publicKeyFromPrivateKey(sk);
    this.#pkBytes = fp5ToBytes(pk);
  }

  /**
   * Parse a private key: 40 little-endian bytes, or the same as hex with or without a `0x` prefix.
   *
   * The bytes are length-checked exactly and then reduced mod `n` — the reducing parse the whole
   * sign/verify path uses (`docs/decisions.md` D3). A key that reduces to zero is refused.
   *
   * @throws LighterSignatureError on a wrong length, a non-hex string, or `sk ≡ 0 (mod n)`. The
   *         message names lengths and reasons only; it never contains the key.
   */
  static fromPrivateKey(key: Uint8Array | string): ApiKey {
    const bytes: Uint8Array = typeof key === "string" ? privateKeyFromHex(key) : key;
    if (bytes.length !== PRIVATE_KEY_BYTES) {
      throw new LighterSignatureError(
        `ApiKey.fromPrivateKey: expected ${String(PRIVATE_KEY_BYTES)} bytes, got ${String(bytes.length)}`,
      );
    }
    return new ApiKey(scalarFromBytes(bytes));
  }

  /**
   * Generate a fresh key pair from the platform CSPRNG.
   *
   * 64 random bytes reduced mod `n`, so the result is uniform in `[1, n)` to within `2^-192` — a
   * 40-byte draw would leave about one bit of bias. The draw is {@link randomNonce}: it is the
   * SDK's single uniform-scalar-from-CSPRNG routine, and duplicating its `globalThis` resolution
   * here would mean two places to get the Workers module-scope rule wrong.
   *
   * @throws LighterSignatureError if no CSPRNG is available. There is no fallback: a key derived
   *         from anything weaker is a key an attacker can also derive.
   */
  static generate(): ApiKey {
    let sk: Scalar;
    try {
      sk = randomNonce();
    } catch (cause: unknown) {
      throw new LighterSignatureError(
        "ApiKey.generate: a platform CSPRNG is required — globalThis.crypto.getRandomValues is " +
          "unavailable or unusable",
        { cause },
      );
    }
    return new ApiKey(sk);
  }

  /** Canonical 40-byte little-endian private key. A fresh copy per read; mutating it changes nothing. */
  get privateKeyBytes(): Uint8Array {
    return this.#skBytes.slice();
  }

  /** Canonical 40-byte little-endian public key. A fresh copy per read. */
  get publicKeyBytes(): Uint8Array {
    return this.#pkBytes.slice();
  }

  /** `0x`-prefixed lowercase hex, 82 characters. */
  get privateKeyHex(): string {
    return `0x${bytesToHex(this.#skBytes)}`;
  }

  /**
   * `0x`-prefixed lowercase hex, 82 characters.
   *
   * This is the form the server compares against, which is why the underlying bytes are canonical
   * and the hex is lowercase — both are string comparisons on the far side.
   */
  get publicKeyHex(): string {
    return `0x${bytesToHex(this.#pkBytes)}`;
  }

  /**
   * Sign a 40-byte hashed message. Returns 80 bytes: `s` then `e`.
   *
   * **Synchronous on every runtime.** Nothing on this path is async, so the signature is available
   * to the caller in the same tick.
   *
   * The message is parsed with the reducing parser and re-encoded canonically before nonce
   * derivation, so two spellings of one message cannot produce two different nonces.
   *
   * @throws LighterSignatureError if `hashedMessage` is not exactly {@link HASH_BYTES} bytes, if an
   *         explicit nonce is zero mod `n`, or if `'random'` is requested with no CSPRNG present.
   */
  sign(hashedMessage: Uint8Array, opts?: SignOptions): Uint8Array {
    if (hashedMessage.length !== HASH_BYTES) {
      throw new LighterSignatureError(
        `ApiKey.sign: expected a ${String(HASH_BYTES)}-byte hashed message, got ${String(hashedMessage.length)}`,
      );
    }

    const m: Fp5 = fp5FromBytes(hashedMessage);
    const canonicalMsg: Uint8Array = fp5ToBytes(m);

    const k: Scalar = chooseNonce(this.#skBytes, canonicalMsg, opts?.nonce ?? "hedged");
    const sig: Signature = signHashed(m, this.#sk, k);
    return signatureToBytes(sig);
  }
}

/**
 * Decode a private key given as hex, with or without a `0x`/`0X` prefix.
 *
 * Wraps the shared decoder so that every constructor failure is a `LighterSignatureError`, and so
 * that the length is diagnosed in hex characters rather than after a partial decode. The offending
 * string is never quoted back — this function is handed private keys.
 */
function privateKeyFromHex(key: string): Uint8Array {
  const body: string = key.startsWith("0x") || key.startsWith("0X") ? key.slice(2) : key;
  if (body.length !== PRIVATE_KEY_HEX_CHARS) {
    throw new LighterSignatureError(
      `ApiKey.fromPrivateKey: expected ${String(PRIVATE_KEY_HEX_CHARS)} hex characters ` +
        `(optionally 0x-prefixed), got ${String(body.length)}`,
    );
  }
  try {
    return hexToBytes(body);
  } catch (cause: unknown) {
    throw new LighterSignatureError(
      "ApiKey.fromPrivateKey: the private key is not valid hexadecimal",
      { cause },
    );
  }
}
