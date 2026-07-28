/**
 * The one number format used by every L1 message template: `0x` followed by exactly sixteen
 * zero-padded lowercase hex digits.
 *
 * ## The name is a trap in the reference, so it is not the name here
 *
 * The reference SDK calls this function `hex10` and it produces **16** digits, not 10
 * (`spec/04-tx-types.md` §10.1). A faithful-looking port that pads to 10 builds a message that is
 * well-formed, signs cleanly, and is rejected by the sequencer with nothing to point at. This
 * module is named for what the function does.
 *
 * ## It is a *different* rule from the transaction-hash field encoder
 *
 * Both take a protocol integer and both start with `BigInt.asUintN(64, v)`. They diverge
 * immediately after:
 *
 * | Input | {@link hex16} | `toField` in `src/tx/field-encode.ts` |
 * | --- | --- | --- |
 * | `-1` | `"0xffffffffffffffff"` | `4294967294` |
 *
 * The field encoder reduces the 64-bit word mod `p = 2^64 - 2^32 + 1` because it is producing a
 * field element for Poseidon2 (`docs/protocol-notes.md` §3.1). {@link hex16} is producing text for
 * a human-readable message and never reduces. Two correct answers for the same input in the same
 * package: do not import one where the other belongs. `test/tx/l1/hex16.test.ts` pins the
 * divergence so it stays deliberate.
 *
 * ## Domain
 *
 * `[-2^63, 2^64)` — every declared protocol width, and the same domain the field encoder accepts.
 * Anything outside it would be silently truncated by `BigInt.asUintN` into a perfectly plausible
 * sixteen-digit string, so it throws instead: the whole point of this module is that a wrong
 * message is undebuggable downstream.
 */

import { LighterValidationError } from "../../errors.js";

/** `int64` minimum — the lowest value any protocol integer can carry. */
const I64_MIN: bigint = -9223372036854775808n;

/** `uint64` maximum — the highest value any protocol integer can carry. */
const U64_MAX: bigint = 18446744073709551615n;

/** Digits after the `0x`. Fixed by the protocol, not derived from the value's magnitude. */
const DIGITS: 16 = 16;

/**
 * Format a protocol integer as `0x` + 16 zero-padded lowercase hex digits (18 characters total).
 *
 * The value is reinterpreted as a two's-complement `uint64`, so negative inputs render as their
 * unsigned bit pattern: `hex16(-1n) === "0xffffffffffffffff"`.
 *
 * ```ts
 * hex16(0n);                  // "0x0000000000000000"
 * hex16(42);                  // "0x000000000000002a"
 * hex16(304);                 // "0x0000000000000130"
 * hex16(140737488355327n);    // "0x00007fffffffffff"
 * ```
 *
 * @throws {LighterValidationError} `UNSAFE_INTEGER` for a `number` that is not a safe integer;
 * `VALUE_TOO_LOW` or `VALUE_TOO_HIGH` for an integer outside `[-2^63, 2^64)`.
 */
export function hex16(v: bigint | number): string {
  let wide: bigint;
  if (typeof v === "bigint") {
    wide = v;
  } else {
    if (!Number.isSafeInteger(v)) {
      throw new LighterValidationError(
        "UNSAFE_INTEGER",
        `hex16: ${String(v)} is not a safe integer; pass a bigint for values beyond 2^53 - 1`,
      );
    }
    wide = BigInt(v);
  }
  if (wide < I64_MIN) {
    throw new LighterValidationError(
      "VALUE_TOO_LOW",
      `hex16: ${wide.toString()} < ${I64_MIN.toString()}`,
      { bound: I64_MIN },
    );
  }
  if (wide > U64_MAX) {
    throw new LighterValidationError(
      "VALUE_TOO_HIGH",
      `hex16: ${wide.toString()} > ${U64_MAX.toString()}`,
      { bound: U64_MAX },
    );
  }
  return `0x${BigInt.asUintN(64, wide).toString(16).padStart(DIGITS, "0")}`;
}
