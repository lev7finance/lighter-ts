/**
 * Auth tokens — the credential that authenticates a **read**, without a private key at request time.
 *
 * A token is four colon-separated fields:
 *
 * ```text
 * deadline  = timestamp + expirySeconds                    // unix SECONDS
 * message   = "<deadline>:<accountIndex>:<apiKeyIndex>"    // decimal, colon-separated
 * elements  = pack(utf8(message))                          // 8 bytes per field element,
 *                                                          // LITTLE-ENDIAN, tail zero-padded to 8
 * msgHash   = hashToQuinticExtension(elements) → 40 LE bytes
 * token     = message + ":" + hex(schnorrSign(msgHash))    // lowercase hex, no 0x
 * ```
 *
 * Every byte of that is pinned by `conformance/vectors/tx.json` → `authTokens`
 * (`docs/protocol-notes.md` §6). The whole format is three integers and a signature, which makes it
 * look forgiving; it is not, and the four ways to get it wrong are all silent:
 *
 * 1. **The deadline is unix seconds.** Nothing in the payload marks the unit (risk R11), and a
 *    millisecond deadline is a syntactically perfect token the server refuses. {@link createAuthToken}
 *    therefore rejects a `timestamp` large enough to be milliseconds rather than quietly signing it.
 * 2. **The packing is little-endian per 8-byte chunk, and the tail is zero-padded to a full 8
 *    bytes** — not truncated to what is left. `"1750000000:1:0"` is 14 bytes and packs to *two*
 *    elements, the second of which is the little-endian reading of `00:1:0\x00\x00`. A big-endian
 *    pack, or a 6-byte tail element, yields a hash that verifies against nothing.
 * 3. **There is one Poseidon2.** The reference imports `poseidon2_goldilocks` here and
 *    `poseidon2_goldilocks_plonky2` for transaction hashing, which reads like two different hash
 *    functions. They differ in internal field representation, not in the function computed
 *    (`docs/protocol-notes.md` §2), so this uses the single implementation in `src/crypto/poseidon2/`.
 * 4. **The signature hex is lowercase and carries no `0x`.**
 *
 * ## The token is a bearer credential
 *
 * Anyone holding it can read the account until the deadline passes. Prefer the `Authorization`
 * header over the `auth` query parameter: a query parameter puts the credential into URLs, access
 * logs and referrers (`docs/protocol-notes.md` §8.1.1). Nothing in this module logs, and no error
 * raised here contains a token or a key — `redactString` in `src/util/redact.ts` recognises both
 * shapes, and the redaction test in `test/client/auth-token.test.ts` asserts it.
 *
 * No module-scope randomness, no clock read at import, no Node built-ins, no I/O.
 */

import { type Fp, fpFromBytes } from "../crypto/field/fp.js";
import { type Fp5, fp5ToBytes } from "../crypto/field/fp5.js";
import type { ApiKey, SignOptions } from "../crypto/key.js";
import { hashToQuinticExtension } from "../crypto/poseidon2/index.js";
import { LighterConfigError, LighterValidationError } from "../errors.js";
import { bytesToHex, utf8ToBytes } from "../util/bytes.js";

/* ---------------------------------------------------------------------------------------------- */
/* Constants                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** Bytes absorbed into one field element. The message is packed 8 bytes at a time. */
export const AUTH_TOKEN_FIELD_BYTES: 8 = 8;

/**
 * Default lifetime, in seconds: 10 minutes — the Python client's default.
 *
 * Short on purpose. A token is a bearer credential and the cost of a fresh one is a single Schnorr
 * signature; the pre-generation schedule in `./auth-schedule.ts` is the case where a long lifetime
 * is the point, and it states its own.
 */
export const DEFAULT_AUTH_TOKEN_EXPIRY_SECONDS: 600 = 600;

/**
 * The lifetime cap this SDK enforces locally: 8 hours.
 *
 * **Which bound the server actually enforces is an open question** (`docs/ARCHITECTURE.md` §11,
 * open question 14): the documentation says 8 hours, the Python client defaults to 10 minutes, and
 * the shared Go library defaults to 7 hours. Nothing has been measured against a live server. So
 * this is a configurable constant rather than a protocol fact — pass `maxLifetimeSeconds` to
 * {@link createAuthToken} to tighten it, and expect to *lower* this default if the server turns out
 * to be stricter. It is never raised silently: a request above the cap throws before signing.
 */
export const MAX_AUTH_TOKEN_LIFETIME_SECONDS: 28_800 = 28_800;

/** The nil API key marker. Never a real signing index; the valid range is `[0, 254]`. */
const API_KEY_INDEX_NIL: 255 = 255;

/**
 * A timestamp above this is milliseconds that were meant to be seconds.
 *
 * `1e11` seconds is the year 5138, so no legitimate deadline reaches it, while every plausible
 * millisecond epoch (`~1.7e12` today) is far above it. The units carry no in-payload marker, so
 * this is the only place the mistake can be caught locally rather than as an opaque server refusal.
 */
const MAX_PLAUSIBLE_TIMESTAMP_SECONDS: 100_000_000_000 = 100_000_000_000;

/* ---------------------------------------------------------------------------------------------- */
/* Context                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What signing a token needs: an account, its keys, and a clock.
 *
 * Structural, so `LighterAccount`'s own submit context satisfies it without this module depending
 * on the account class — and so a test can hand it two literals and no transport. There is no
 * network access on this path at all: a token is produced entirely offline.
 */
export interface AuthTokenContext {
  /** The account the token authenticates. Rendered in decimal into the message. */
  readonly accountIndex: bigint;
  /** `apiKeyIndex → ApiKey`. The only reachable secret material on this path. */
  readonly keys: ReadonlyMap<number, ApiKey>;
  /** Injected clock, **milliseconds**, like `Date.now`. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
}

/** Per-call overrides for {@link createAuthToken}. */
export interface CreateAuthTokenOptions {
  /** Lifetime in **seconds**. Default {@link DEFAULT_AUTH_TOKEN_EXPIRY_SECONDS} (600). */
  readonly expirySeconds?: number;
  /** Issue time as a unix timestamp in **seconds**. Default `floor(now() / 1000)`. */
  readonly timestamp?: number;
  /** Which key signs. Default: the account's first configured key. */
  readonly apiKeyIndex?: number;
  /** Override the local lifetime cap. Default {@link MAX_AUTH_TOKEN_LIFETIME_SECONDS}. */
  readonly maxLifetimeSeconds?: number;
  /**
   * Passed to the signer. `{ nonce: k }` pins the Schnorr nonce and is how the `authTokens` vectors
   * are replayed; the default is hedged-deterministic (`docs/decisions.md` D2) and produces a
   * different — equally valid — signature every time.
   */
  readonly sign?: SignOptions;
}

/* ---------------------------------------------------------------------------------------------- */
/* Packing and hashing                                                                              */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Pack bytes into field elements: 8 bytes each, little-endian, final chunk **zero-padded to 8**.
 *
 * Each chunk is validated against the Goldilocks modulus and **errors rather than reducing**. It
 * cannot trigger for a token message — ASCII digits and colons put every chunk far below `p` — but
 * the check stays, because this function's contract is "these bytes are these field elements", and
 * a silent reduction would make that false for some other caller's input.
 *
 * @throws {LighterValidationError} `AUTH_TOKEN_FIELD_NOT_CANONICAL` if any 8-byte chunk, read
 * little-endian, is `>= p`. The chunk's index is named; its bytes are not, since this function is
 * generic over its input and that input may be a secret.
 */
export function packAuthMessage(bytes: Uint8Array): Fp[] {
  const out: Fp[] = [];
  //  Reused across iterations: `fpFromBytes` reads it synchronously and returns a `bigint`, so no
  //  element retains a reference to the buffer.
  const chunk: Uint8Array = new Uint8Array(AUTH_TOKEN_FIELD_BYTES);
  for (let offset: number = 0; offset < bytes.length; offset += AUTH_TOKEN_FIELD_BYTES) {
    const end: number = Math.min(offset + AUTH_TOKEN_FIELD_BYTES, bytes.length);
    // Zero-padded, not truncated: a short tail still absorbs as a full 8-byte little-endian word.
    chunk.fill(0);
    chunk.set(bytes.subarray(offset, end));
    try {
      out.push(fpFromBytes(chunk));
    } catch (cause: unknown) {
      throw new LighterValidationError(
        "AUTH_TOKEN_FIELD_NOT_CANONICAL",
        `field element ${String(offset / AUTH_TOKEN_FIELD_BYTES)} is not below the Goldilocks ` +
          "modulus; these bytes are rejected rather than reduced",
        { cause, field: "auth" },
      );
    }
  }
  return out;
}

/**
 * The exact message a token signs: three decimal integers, colon-separated, no spaces.
 *
 * Rendered from `bigint` and `number` directly — never through a locale-aware or exponent-producing
 * formatter, both of which turn a large account index into a message the server cannot parse.
 */
export function authTokenMessage(
  deadlineSeconds: bigint,
  accountIndex: bigint,
  apiKeyIndex: number,
): string {
  return `${deadlineSeconds.toString(10)}:${accountIndex.toString(10)}:${apiKeyIndex.toString(10)}`;
}

/**
 * The 40-byte little-endian digest a token's signature covers.
 *
 * `hashToQuinticExtension(pack(utf8(message)))`, encoded as five canonical little-endian `uint64`s.
 * Pinned by `authTokens[*].messageHashLeHex`.
 */
export function authTokenMessageHash(message: string): Uint8Array {
  const elements: Fp[] = packAuthMessage(utf8ToBytes(message));
  const digest: Fp5 = hashToQuinticExtension(elements);
  return fp5ToBytes(digest);
}

/* ---------------------------------------------------------------------------------------------- */
/* Validation                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Reject a lifetime the server will not accept — **before** anything is signed.
 *
 * The cap defaults to {@link MAX_AUTH_TOKEN_LIFETIME_SECONDS} (8 hours) and is a local policy, not
 * a measured protocol constant; see that constant's note and open question 14.
 *
 * @throws {LighterValidationError} `AUTH_TOKEN_LIFETIME_INVALID` for a non-integer, a
 * non-positive value, or anything above the cap.
 */
export function assertAuthTokenLifetime(expirySeconds: number, maxSeconds?: number): void {
  const cap: number = maxSeconds ?? MAX_AUTH_TOKEN_LIFETIME_SECONDS;
  if (!Number.isInteger(expirySeconds)) {
    throw new LighterValidationError(
      "AUTH_TOKEN_LIFETIME_INVALID",
      `an auth token lifetime is a whole number of seconds, received ${String(expirySeconds)}`,
      { field: "deadline" },
    );
  }
  if (expirySeconds <= 0) {
    throw new LighterValidationError(
      "AUTH_TOKEN_LIFETIME_INVALID",
      `an auth token lifetime must be positive, received ${String(expirySeconds)} seconds`,
      { field: "deadline", bound: 1 },
    );
  }
  if (expirySeconds > cap) {
    throw new LighterValidationError(
      "AUTH_TOKEN_LIFETIME_INVALID",
      `an auth token lifetime of ${String(expirySeconds)} seconds exceeds the ${String(cap)}-second ` +
        "maximum; the enforced server bound is open question 14, so this cap is configurable",
      { field: "deadline", bound: cap },
    );
  }
}

/**
 * Reject an API key index outside `[0, 254]`.
 *
 * `255` is the nil marker used by `GET /apikeys` to mean "every key", and is never a signing index.
 * `0` is the web app's slot, so SDK users should use `>= 1`; `253` is the read-only convention.
 */
function assertApiKeyIndex(apiKeyIndex: number): void {
  if (!Number.isInteger(apiKeyIndex) || apiKeyIndex < 0 || apiKeyIndex >= API_KEY_INDEX_NIL) {
    throw new LighterValidationError(
      "API_KEY_INDEX_INVALID",
      `an api key index is an integer in [0, 254], received ${String(apiKeyIndex)}; 255 is the nil ` +
        "marker and is not a real index",
      { field: "api_key_index", bound: API_KEY_INDEX_NIL - 1 },
    );
  }
}

/** The issue time, validated as **seconds**. See {@link MAX_PLAUSIBLE_TIMESTAMP_SECONDS}. */
function assertTimestampSeconds(timestamp: number): void {
  if (!Number.isInteger(timestamp) || timestamp < 0) {
    throw new LighterValidationError(
      "AUTH_TOKEN_TIMESTAMP_INVALID",
      `an auth token timestamp is a non-negative whole number of seconds, received ${String(timestamp)}`,
      { field: "deadline" },
    );
  }
  if (timestamp > MAX_PLAUSIBLE_TIMESTAMP_SECONDS) {
    throw new LighterValidationError(
      "AUTH_TOKEN_TIMESTAMP_INVALID",
      `an auth token timestamp is unix SECONDS; ${String(timestamp)} is far beyond any plausible ` +
        "date and is almost certainly milliseconds. Divide by 1000",
      { field: "deadline", bound: MAX_PLAUSIBLE_TIMESTAMP_SECONDS },
    );
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Key selection                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

/** The account's default signing key: the first configured index, as `LighterAccount` defines it. */
export function defaultAuthKeyIndex(ctx: AuthTokenContext): number {
  const first: number | undefined = ctx.keys.keys().next().value;
  if (first === undefined) {
    throw new LighterConfigError(
      "this account holds no api keys, so it cannot sign an auth token; pass `keys: { 1: '0x…' }`",
    );
  }
  return first;
}

/**
 * The key for an index, or a typed refusal naming the configured indices.
 *
 * No key material appears in the message — only indices, which are not secret.
 */
function authKeyFor(ctx: AuthTokenContext, apiKeyIndex: number): ApiKey {
  const key: ApiKey | undefined = ctx.keys.get(apiKeyIndex);
  if (key === undefined) {
    const configured: string = [...ctx.keys.keys()].join(", ");
    throw new LighterConfigError(
      `no private key is configured for api key index ${String(apiKeyIndex)}; this account holds ` +
        `${configured.length === 0 ? "none" : `[${configured}]`}`,
    );
  }
  return key;
}

/* ---------------------------------------------------------------------------------------------- */
/* The token                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Build and sign an auth token. Synchronous, offline, and allocation-only.
 *
 * The order is deliberate: **every** validation runs before the key is even looked up, so a
 * rejected lifetime costs no signature and touches no secret. The signature is the last step.
 *
 * The result is a bearer credential. Send it in the `Authorization` header rather than the `auth`
 * query parameter (`docs/protocol-notes.md` §8.1.1), and never log it — `redactString` recognises
 * its shape if it escapes into free text, but not logging it is cheaper than redacting it.
 *
 * @throws {LighterValidationError} for a lifetime above the cap, a non-integer or millisecond-looking
 * timestamp, or an api key index outside `[0, 254]`.
 * @throws {LighterConfigError} if the requested key is not configured on this account.
 */
export function createAuthToken(ctx: AuthTokenContext, o?: CreateAuthTokenOptions): string {
  const expirySeconds: number = o?.expirySeconds ?? DEFAULT_AUTH_TOKEN_EXPIRY_SECONDS;
  assertAuthTokenLifetime(expirySeconds, o?.maxLifetimeSeconds);

  const nowMs: number = (ctx.now ?? Date.now)();
  const timestamp: number = o?.timestamp ?? Math.floor(nowMs / 1000);
  assertTimestampSeconds(timestamp);

  const apiKeyIndex: number = o?.apiKeyIndex ?? defaultAuthKeyIndex(ctx);
  assertApiKeyIndex(apiKeyIndex);

  const key: ApiKey = authKeyFor(ctx, apiKeyIndex);

  // `bigint` throughout: the deadline is compared against a server clock, and a `number` addition
  // near 2^53 is exactly the class of silent arithmetic this SDK does not do (`decisions.md` D7).
  const deadline: bigint = BigInt(timestamp) + BigInt(expirySeconds);
  const message: string = authTokenMessage(deadline, ctx.accountIndex, apiKeyIndex);
  const signature: Uint8Array = key.sign(authTokenMessageHash(message), o?.sign);
  return `${message}:${bytesToHex(signature)}`;
}
