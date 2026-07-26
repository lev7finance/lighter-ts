/**
 * Memo ergonomics for the client tier.
 *
 * A transfer's `Memo` is exactly 32 bytes, and it is the one transaction field that is **absent
 * from the L2 hash** — it is bound to the transaction only by the L1 signature
 * (`spec/04-tx-types.md` §7.5, `docs/protocol-notes.md` §5.3). A wrong memo therefore produces a
 * transaction whose L2 signature verifies perfectly and whose L1 signature covers different bytes,
 * which is why every path into the field is validated here rather than trusted.
 *
 * ## What this module adds, and what it deliberately does not re-implement
 *
 * `src/tx/opts.ts` already owns `memoFromHex` (64 hex digits, `0x` optional) and `memoFromUtf8`
 * (UTF-8, right zero-padded). They are re-exported below and are the only byte validators used —
 * duplicating the length check in two places is how the two copies eventually disagree.
 *
 * What is added is {@link memoFromAddress}, the fast-withdraw encoding, and {@link toMemo}, a
 * narrow accepting front door.
 *
 * ## The overload the reference has and this SDK refuses
 *
 * The reference accepts a memo as 64 hex characters, as `0x` + 64 hex characters, **or** as a
 * 32-character raw ASCII string, and picks between them by looking at the string. That is a trap:
 * `"0123456789abcdef0123456789abcdef"` is simultaneously a valid 32-character ASCII memo and a
 * plausible-looking hex fragment, and the two readings put different bytes into the field the user
 * is about to sign. So {@link toMemo} accepts **only** `Uint8Array(32)` or a `0x`-prefixed 64-hex
 * string; text goes through {@link memoFromUtf8} explicitly, at the call site, in the caller's own
 * code.
 */

import { LighterValidationError } from "../../errors.js";
import { MEMO_LENGTH } from "../../tx/constants.js";
import { hexToBytes } from "../../util/bytes.js";

export { memoFromHex, memoFromUtf8 } from "../../tx/opts.js";

/** Length of an Ethereum address in bytes. The remaining 12 memo bytes are zero. */
const ADDRESS_LENGTH: 20 = 20;

/** `0x` followed by exactly 40 hex digits, either case. */
const ADDRESS_PATTERN: RegExp = /^0x[0-9a-fA-F]{40}$/;

/** `0x` followed by exactly 64 hex digits, either case. */
const MEMO_HEX_PATTERN: RegExp = /^0x[0-9a-fA-F]{64}$/;

/**
 * What a client-tier caller may hand to a memo parameter.
 *
 * Two forms, both unambiguous. A bare string is **not** one of them; see the module header.
 */
export type MemoInput = Uint8Array | `0x${string}`;

/**
 * The fast-withdraw memo: the 20 bytes of an L1 address followed by 12 zero bytes.
 *
 * This is how the recipient of a fast withdrawal is authenticated (`spec/07-high-level-client.md`
 * §10.I) — the bridge reads the destination out of the memo of the L2 transfer that funds it, and
 * the memo is covered by the L1 signature and by nothing else.
 *
 * The address is **not** checksummed here: this package ships no keccak256 (`docs/decisions.md`
 * D6, D10), so an EIP-55 check is not available and pretending otherwise would be worse than not
 * checking. Case is accepted in either form and the bytes are the same either way.
 *
 * @throws {LighterValidationError} `L1_ADDRESS_INVALID` if `address` is not `0x` + 40 hex digits.
 */
export function memoFromAddress(address: `0x${string}`): Uint8Array {
  if (typeof address !== "string" || !ADDRESS_PATTERN.test(address)) {
    throw new LighterValidationError(
      "L1_ADDRESS_INVALID",
      "an L1 address is 0x followed by 40 hex digits",
      { field: "to_address" },
    );
  }
  const out: Uint8Array = new Uint8Array(MEMO_LENGTH);
  out.set(hexToBytes(address.slice(2)), 0);
  return out;
}

/**
 * Normalise a {@link MemoInput} into exactly 32 bytes, copying whatever the caller passed.
 *
 * The copy matters: the transaction builder freezes the object but a `Uint8Array` inside it is
 * still writable, and a memo mutated after the L1 signature was produced would leave a signature
 * over bytes that are no longer there. `buildTransfer` copies as well; two copies of 32 bytes are
 * cheaper than one class of silent corruption.
 *
 * @throws {LighterValidationError} `MEMO_LENGTH_INVALID` for a `Uint8Array` of the wrong length or
 * a string that is not `0x` + 64 hex digits.
 */
export function toMemo(input: MemoInput): Uint8Array {
  if (input instanceof Uint8Array) return assertMemo(input).slice();
  if (typeof input === "string") {
    if (!MEMO_HEX_PATTERN.test(input)) {
      throw new LighterValidationError(
        "MEMO_LENGTH_INVALID",
        `a memo string is 0x followed by exactly ${String(MEMO_LENGTH * 2)} hex digits; for text, ` +
          "call memoFromUtf8() explicitly — this SDK does not guess between hex and ASCII",
        { field: "Memo", bound: MEMO_LENGTH },
      );
    }
    return hexToBytes(input.slice(2));
  }
  throw new LighterValidationError(
    "MEMO_LENGTH_INVALID",
    "a memo is a 32-byte Uint8Array or a 0x-prefixed 64-digit hex string",
    { field: "Memo", bound: MEMO_LENGTH },
  );
}

/**
 * Re-validate a memo that is already bytes, returning it unchanged.
 *
 * Used on the way into a transaction the caller assembled itself, where the only remaining
 * question is the length.
 *
 * @throws {LighterValidationError} `MEMO_LENGTH_INVALID` if `memo` is not exactly 32 bytes.
 */
export function assertMemo(memo: Uint8Array): Uint8Array {
  if (!(memo instanceof Uint8Array) || memo.length !== MEMO_LENGTH) {
    throw new LighterValidationError(
      "MEMO_LENGTH_INVALID",
      `a memo is exactly ${String(MEMO_LENGTH)} bytes, got ${
        memo instanceof Uint8Array ? String(memo.length) : typeof memo
      }`,
      { field: "Memo", bound: MEMO_LENGTH },
    );
  }
  return memo;
}

/** 32 zero bytes: the memo of a transfer that carries no message. A fresh array every call. */
export function emptyMemo(): Uint8Array {
  return new Uint8Array(MEMO_LENGTH);
}

/**
 * The 20 address bytes of a fast-withdraw memo, as `0x` + 40 lowercase hex — the inverse of
 * {@link memoFromAddress}, for reading a transfer back.
 *
 * @throws {LighterValidationError} `MEMO_LENGTH_INVALID` for a memo that is not 32 bytes, or
 * `L1_ADDRESS_INVALID` when the trailing 12 bytes are not zero — that memo does not encode an
 * address, and returning its first 20 bytes anyway would invent a recipient.
 */
export function addressFromMemo(memo: Uint8Array): `0x${string}` {
  assertMemo(memo);
  for (let i: number = ADDRESS_LENGTH; i < MEMO_LENGTH; i += 1) {
    if (memo[i] !== 0) {
      throw new LighterValidationError(
        "L1_ADDRESS_INVALID",
        "this memo does not encode an L1 address: its trailing 12 bytes are not zero",
        { field: "Memo" },
      );
    }
  }
  let hex: string = "";
  for (let i: number = 0; i < ADDRESS_LENGTH; i += 1) {
    hex += (memo[i] as number).toString(16).padStart(2, "0");
  }
  return `0x${hex}`;
}
