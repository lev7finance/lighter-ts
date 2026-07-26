/**
 * Byte encoding for the wire.
 *
 * Everything the protocol puts on a socket is bytes: 40-byte field elements, 80-byte signatures,
 * 8-byte little-endian protocol integers, base64 `Sig`/`PubKey` fields inside `tx_info`, UTF-8
 * EIP-191 message bodies. This module is the only place those conversions happen.
 *
 * Three constraints shape the implementation:
 *
 * 1. **No Node built-ins.** The one-line answer to every function here is a Node-only class this
 *    package refuses, so each encoder is table-driven and written out. Roughly twenty lines each,
 *    identical on Bun, Node, Deno, Workers and browsers.
 * 2. **No platform base64 helpers.** The global decoder yields a latin-1 string that then needs a
 *    second conversion, and the global encoder is normally fed through `String.fromCharCode(...b)`,
 *    which overflows the call stack on large inputs. A 64-entry table has neither problem.
 * 3. **Encoders emit lowercase hex, always.** `txHashHex` is 80 lowercase hex characters with no
 *    `0x` prefix, and a mixed-case encoder would compare unequal against every conformance vector
 *    while looking correct to a human.
 *
 * Decoders are strict: a bad character is a thrown {@link LighterValidationError}, never a silently
 * substituted zero byte. Per-pair integer parsing returns `NaN` for garbage input and would encode
 * `"zz"` as `0x00`, which is precisely the class of bug that produces a valid-looking signature over
 * the wrong message.
 *
 * Module initialisation builds three small lookup tables. No I/O, no timers, no randomness.
 */

import { LighterValidationError } from "../errors.js";

/** Marker stored in the decode tables for "this character is not in the alphabet". */
const INVALID: 255 = 255;

const HEX_DIGITS: string = "0123456789abcdef";

/** `HEX_PAIRS[b]` is the lowercase two-character hex encoding of byte `b`. */
function buildHexPairs(): readonly string[] {
  const pairs: string[] = new Array<string>(256);
  for (let i: number = 0; i < 256; i += 1) {
    pairs[i] = HEX_DIGITS.charAt(i >>> 4) + HEX_DIGITS.charAt(i & 0x0f);
  }
  return pairs;
}

/** `HEX_NIBBLES[c]` is the value 0–15 of ASCII code `c`, or {@link INVALID}. Both cases accepted. */
function buildHexNibbles(): Uint8Array {
  const table: Uint8Array = new Uint8Array(256).fill(INVALID);
  for (let i: number = 0; i < 10; i += 1) table[0x30 + i] = i; // '0'..'9'
  for (let i: number = 0; i < 6; i += 1) {
    table[0x61 + i] = 10 + i; // 'a'..'f'
    table[0x41 + i] = 10 + i; // 'A'..'F'
  }
  return table;
}

const B64_ALPHABET: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** `B64_VALUES[c]` is the 6-bit value of ASCII code `c`, or {@link INVALID}. */
function buildB64Values(): Uint8Array {
  const table: Uint8Array = new Uint8Array(256).fill(INVALID);
  for (let i: number = 0; i < 64; i += 1) table[B64_ALPHABET.charCodeAt(i)] = i;
  return table;
}

const HEX_PAIRS: readonly string[] = buildHexPairs();
const HEX_NIBBLES: Uint8Array = buildHexNibbles();
const B64_VALUES: Uint8Array = buildB64Values();

/** Largest value representable in 64 unsigned bits, inclusive. */
const MAX_U64: bigint = 0xffff_ffff_ffff_ffffn;

/** Shared UTF-8 codecs. Constructing them allocates nothing observable and touches no I/O. */
const UTF8_ENCODER: TextEncoder = new TextEncoder();
const UTF8_DECODER: TextDecoder = new TextDecoder();

/**
 * Lowercase hex, no `0x` prefix. The inverse of {@link hexToBytes}.
 *
 * Never uppercase: transaction hashes, public keys and signatures are compared as strings against
 * vectors and against server responses.
 */
export function bytesToHex(b: Uint8Array): string {
  let out: string = "";
  for (let i: number = 0; i < b.length; i += 1) {
    out += HEX_PAIRS[b[i] as number] as string;
  }
  return out;
}

/**
 * Decode hex, with or without a leading `0x` / `0X`.
 *
 * Throws {@link LighterValidationError} on an odd length or any character outside `[0-9a-fA-F]`.
 * The offending value is never included in the message — this function decodes private keys.
 */
export function hexToBytes(s: string): Uint8Array {
  let body: string = s;
  if (
    s.length >= 2 &&
    s.charCodeAt(0) === 0x30 &&
    (s.charCodeAt(1) === 0x78 || s.charCodeAt(1) === 0x58)
  ) {
    body = s.slice(2);
  }
  if ((body.length & 1) !== 0) {
    throw new LighterValidationError(
      "INVALID_HEX",
      `hex string must have an even number of digits, got ${body.length}`,
    );
  }
  const out: Uint8Array = new Uint8Array(body.length >>> 1);
  for (let i: number = 0; i < out.length; i += 1) {
    const hi: number = nibbleAt(body, i * 2);
    const lo: number = nibbleAt(body, i * 2 + 1);
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** One hex digit, or a thrown error. Position only in the message; never the character itself. */
function nibbleAt(s: string, index: number): number {
  const code: number = s.charCodeAt(index);
  const value: number = code < 256 ? (HEX_NIBBLES[code] as number) : INVALID;
  if (value === INVALID) {
    throw new LighterValidationError(
      "INVALID_HEX",
      `hex string has a non-hexadecimal character at index ${index}`,
    );
  }
  return value;
}

/** Standard RFC 4648 alphabet, always `=` padded to a multiple of four characters. */
export function bytesToBase64(b: Uint8Array): string {
  const n: number = b.length;
  const full: number = n - (n % 3);
  let out: string = "";
  for (let i: number = 0; i < full; i += 3) {
    const word: number = ((b[i] as number) << 16) | ((b[i + 1] as number) << 8) | (b[i + 2] as number);
    out +=
      B64_ALPHABET.charAt((word >>> 18) & 0x3f) +
      B64_ALPHABET.charAt((word >>> 12) & 0x3f) +
      B64_ALPHABET.charAt((word >>> 6) & 0x3f) +
      B64_ALPHABET.charAt(word & 0x3f);
  }
  const remainder: number = n - full;
  if (remainder === 1) {
    const word: number = (b[full] as number) << 16;
    out += B64_ALPHABET.charAt((word >>> 18) & 0x3f) + B64_ALPHABET.charAt((word >>> 12) & 0x3f) + "==";
  } else if (remainder === 2) {
    const word: number = ((b[full] as number) << 16) | ((b[full + 1] as number) << 8);
    out +=
      B64_ALPHABET.charAt((word >>> 18) & 0x3f) +
      B64_ALPHABET.charAt((word >>> 12) & 0x3f) +
      B64_ALPHABET.charAt((word >>> 6) & 0x3f) +
      "=";
  }
  return out;
}

/**
 * Decode standard base64. Padding is optional on input; a padded input must be a multiple of four
 * characters. Whitespace, the URL-safe alphabet, a truncated final group and non-zero trailing bits
 * are all rejected rather than quietly reinterpreted.
 */
export function base64ToBytes(s: string): Uint8Array {
  let end: number = s.length;
  let padding: number = 0;
  while (end > 0 && s.charCodeAt(end - 1) === 0x3d && padding < 2) {
    end -= 1;
    padding += 1;
  }
  const remainder: number = end % 4;
  if (remainder === 1) {
    throw new LighterValidationError(
      "INVALID_BASE64",
      `base64 input has a truncated final group (${end} data characters)`,
    );
  }
  if (padding > 0 && (end + padding) % 4 !== 0) {
    throw new LighterValidationError(
      "INVALID_BASE64",
      "padded base64 input must be a multiple of four characters",
    );
  }
  const outLength: number = (end >>> 2) * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
  const out: Uint8Array = new Uint8Array(outLength);
  let written: number = 0;
  let accumulator: number = 0;
  let bits: number = 0;
  for (let i: number = 0; i < end; i += 1) {
    const code: number = s.charCodeAt(i);
    const value: number = code < 256 ? (B64_VALUES[code] as number) : INVALID;
    if (value === INVALID) {
      throw new LighterValidationError(
        "INVALID_BASE64",
        `base64 input has a character outside the standard alphabet at index ${i}`,
      );
    }
    accumulator = ((accumulator << 6) | value) & 0xff_ffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written] = (accumulator >>> bits) & 0xff;
      written += 1;
    }
  }
  if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0) {
    throw new LighterValidationError(
      "INVALID_BASE64",
      "base64 input has non-zero bits after the final byte",
    );
  }
  return out;
}

/** UTF-8 encode. `TextEncoder` exists on every supported runtime. */
export function utf8ToBytes(s: string): Uint8Array {
  return UTF8_ENCODER.encode(s);
}

/**
 * UTF-8 decode, lossy on malformed input (U+FFFD), matching `Response.text()`.
 *
 * A partially delivered frame must not turn into a thrown `TypeError` from deep inside the codec;
 * the caller's JSON parse will produce a far better error.
 */
export function bytesToUtf8(b: Uint8Array): string {
  return UTF8_DECODER.decode(b);
}

/**
 * Eight little-endian bytes.
 *
 * Rejects anything outside `[0, 2^64)`. Callers holding a *signed* protocol integer must
 * sign-extend to 64 unsigned bits first (`BigInt.asUintN(64, v)`), which is what makes
 * `AccountIndex = -1` encode as `4294967294` — see `docs/protocol-notes.md` §3.1.
 */
export function u64ToLeBytes(v: bigint): Uint8Array {
  if (v < 0n || v > MAX_U64) {
    throw new LighterValidationError(
      "VALUE_OUT_OF_RANGE",
      `value does not fit in an unsigned 64-bit integer: ${v.toString()}`,
      { bound: MAX_U64 },
    );
  }
  // Via big-endian hex rather than a per-byte numeric conversion: the whole module is `bigint` and
  // `string` on purpose, and this keeps it that way.
  const hex: string = v.toString(16).padStart(16, "0");
  const out: Uint8Array = new Uint8Array(8);
  for (let i: number = 0; i < 8; i += 1) {
    const at: number = (7 - i) * 2;
    out[i] = (nibbleAt(hex, at) << 4) | nibbleAt(hex, at + 1);
  }
  return out;
}

/** Exactly eight little-endian bytes back to an unsigned integer. Any other length is an error. */
export function leBytesToU64(b: Uint8Array): bigint {
  if (b.length !== 8) {
    throw new LighterValidationError(
      "INVALID_BYTE_LENGTH",
      `expected exactly 8 little-endian bytes, got ${b.length}`,
      { bound: 8 },
    );
  }
  let hex: string = "";
  for (let i: number = 7; i >= 0; i -= 1) {
    hex += HEX_PAIRS[b[i] as number] as string;
  }
  return BigInt("0x" + hex);
}

/** Concatenate. Returns a fresh array; the inputs are never retained or mutated. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total: number = 0;
  for (const part of parts) total += part.length;
  const out: Uint8Array = new Uint8Array(total);
  let offset: number = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Length-then-content equality.
 *
 * The content loop does not exit early. Lengths are public (a signature is always 80 bytes), but
 * the bytes themselves may be a key or a hash, and an early exit turns a comparison into a timing
 * oracle for the first differing byte.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference: number = 0;
  for (let i: number = 0; i < a.length; i += 1) {
    difference |= (a[i] as number) ^ (b[i] as number);
  }
  return difference === 0;
}
