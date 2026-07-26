/**
 * The EIP-191 `personal_sign` framing, and only the framing.
 *
 * `personal_sign` does not sign the message text. It signs
 * `"\x19Ethereum Signed Message:\n" ‖ decimal(byteLength) ‖ text`, digested and signed by the L1
 * key holder. This module builds those prefixed bytes and stops there: no digest, no curve, no key
 * (`docs/decisions.md` D6 and D10 cut all of it from v1 — the consuming application already holds
 * L1 keys in a wallet or custody layer, and this package never has one to sign with).
 *
 * ## Why this exists at all if nothing here signs
 *
 * An injected {@link EthPersonalSigner} takes the *string* and applies the framing itself, so the
 * normal path never calls {@link eip191Message}. It is here for the callers who need the exact
 * pre-image: an out-of-band signer that only accepts bytes, a hardware or KMS interface, an
 * EIP-1193 `personal_sign` request built by hand, and any test that wants to assert what would have
 * been signed. Getting the framing wrong produces a signature over a different pre-image, which
 * fails verification with nothing to point at.
 *
 * ## The length is a byte count
 *
 * The prefix carries the UTF-8 **byte** length, not the character count. Every Lighter template is
 * pure ASCII so the two coincide today — the transfer memo is hex, not free text — but a
 * character-count implementation is wrong the first time it meets a non-ASCII string, and its
 * output looks entirely reasonable. `new TextEncoder()` gives byte length on every runtime; no Node
 * built-ins are used.
 */

import { concatBytes, utf8ToBytes } from "../../util/bytes.js";

/**
 * The EIP-191 personal-message prefix: `0x19`, the fixed text, and a trailing LF.
 *
 * The `\x19` is a single control byte, not the two characters `\` and `x`.
 */
export const EIP191_PREFIX: "\x19Ethereum Signed Message:\n" =
  "\x19Ethereum Signed Message:\n";

/**
 * The exact bytes an EIP-191 signer commits to, for a UTF-8 message.
 *
 * Returns `UTF8(EIP191_PREFIX + byteLength) ‖ UTF8(text)`. **Not** digested — the digest and the
 * signature belong to the injected signer.
 *
 * ```ts
 * eip191Message("abc"); // bytes of "\x19Ethereum Signed Message:\n3abc"
 * ```
 */
export function eip191Message(text: string): Uint8Array {
  const body: Uint8Array = utf8ToBytes(text);
  const header: Uint8Array = utf8ToBytes(`${EIP191_PREFIX}${body.length.toString(10)}`);
  return concatBytes(header, body);
}
