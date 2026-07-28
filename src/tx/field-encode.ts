/**
 * The one rule that turns a protocol integer into a Goldilocks field element, plus the three
 * shapes of 64-bit split the protocol hard-codes.
 *
 * Every Lighter transaction hash is Poseidon2 over an ordered list of `GF(p)` elements, and every
 * element in that list started life as a small integer in a transaction struct. This module is the
 * conversion. It is short and it is the highest-risk code in the transaction codec: both of the
 * plausible answers below are well-formed field elements, so a mistake here is invisible to
 * inspection, produces a wrong hash for every affected transaction, and surfaces as the sequencer
 * rejecting a signature — which reads as a crypto bug rather than a codec bug.
 *
 * ## 1. Negatives sign-extend to 64 bits and *then* reduce
 *
 * `docs/protocol-notes.md` §3.1 and `spec/04-tx-types.md` §1.2:
 *
 * > the absorbed field element is `BigInt.asUintN(64, BigInt(v)) mod p` — sign-extend to 64 bits,
 * > reinterpret the two's-complement bit pattern as unsigned, then reduce.
 *
 * So `AccountIndex = -1` — which is legal, it *is* `MinAccountIndex` — becomes **`4294967294`**
 * (`2^32 - 2`), because `0xFFFFFFFFFFFFFFFF - p = 2^32 - 2`. It does **not** become `p - 1`. The
 * field layer's {@link fpFromInt} performs proper Euclidean reduction and would give `p - 1`; that
 * function is correct for mathematics and wrong for this protocol, which is why the protocol
 * mapping lives here and not there. Pinned by `conformance/vectors/tx.json` ->
 * `cancel_all_orders/negative_account_index`.
 *
 * The reduction is a single conditional subtraction and that is exact: every 64-bit word is below
 * `2p`, since `2p = 2^65 - 2^33 + 2 > 2^64`.
 *
 * ## 2. The lo/hi split is per-field, not per-width
 *
 * Four call sites in the entire protocol absorb a value as *two* elements, low half then high half
 * (`docs/protocol-notes.md` §3.2):
 *
 * | Transaction | Field | Declared | Helper |
 * | --- | --- | --- | --- |
 * | `L2Transfer` | `Amount` | int64 | {@link splitU64} |
 * | `L2Transfer` | `USDCFee` | int64 | {@link splitU64} |
 * | `L2Withdraw` | `Amount` | uint64 | {@link splitU64} |
 * | `L2UpdateMargin` | `USDCAmount` | int64 | {@link splitI64Arith} |
 *
 * Every other field is one element **including fields wider than 32 bits** — `BaseAmount` reaches
 * `2^48 - 1` and `OrderExpiry` is a millisecond timestamp, and neither is split. Choosing the split
 * from a value's magnitude passes every small-value test and produces wrong hashes for large
 * orders. The schema declares which fields split; nothing here infers it.
 *
 * ## 3. `splitU64` and `splitI64Arith` agree on every non-negative input
 *
 * They differ only in the shift: logical on the reinterpreted unsigned word, versus arithmetic on
 * the still-signed value. A test suite built from realistic positive amounts cannot tell them
 * apart. `L2UpdateMargin.USDCAmount` is the one split field where a negative value survives the
 * reference's validation — it checks `!= 0` and an upper bound, with **no lower bound** — so the
 * arithmetic branch is reachable in production, and the three `update_margin/negative_*` vectors
 * pin it. Do not unify them.
 *
 * No Node built-ins, no dependencies: `BigInt` and `Uint8Array` only.
 */

import { LighterValidationError } from "../errors.js";
import { P } from "../crypto/field/constants.js";
import { type Fp, fpFromBytesUnchecked } from "../crypto/field/fp.js";

/** `L2ChangePubKey.PubKey` is exactly this many bytes — 5 little-endian 64-bit limbs. */
const PUBKEY_BYTES: 40 = 40;

/** Low 32 bits set. The mask both split helpers take their low half with. */
const LOW32_MASK: bigint = 0xffffffffn;

/** Smallest value any protocol integer can carry: `int64` minimum. */
const I64_MIN: bigint = -9223372036854775808n;

/** Largest value any protocol integer can carry: `uint64` maximum. */
const U64_MAX: bigint = 18446744073709551615n;

/**
 * Widen the accepted `bigint | number` input to `bigint`, exactly.
 *
 * `BigInt(1.5)` throws, and that throw carries no context; worse, a caller who works around it with
 * a truncation silently changes the transaction. A `number` that is not a safe integer is rejected
 * here with the same `UNSAFE_INTEGER` code `brands.ts` uses, so the diagnosis is the same whichever
 * door the value came in through.
 */
function widen(v: bigint | number): bigint {
  if (typeof v === "bigint") return v;
  if (!Number.isSafeInteger(v)) {
    throw new LighterValidationError(
      "UNSAFE_INTEGER",
      `toField: ${String(v)} is not a safe integer; pass a bigint for values beyond 2^53 - 1`,
    );
  }
  return BigInt(v);
}

/**
 * Reinterpret a protocol integer as a canonical `GF(p)` element.
 *
 * Sign-extend to 64 bits, read the two's-complement bit pattern as unsigned, reduce mod `p`. The
 * declared width of the source field is irrelevant: `int16 -1` and `int64 -1` sign-extend to the
 * same 64-bit word and therefore to the same element, `4294967294`.
 *
 * The `[-2^63, 2^64)` domain covers every declared protocol width. Anything outside it would be
 * *truncated* by `BigInt.asUintN` into a perfectly plausible element, so it throws instead: a loud
 * failure at construction is recoverable, a wrong transaction hash is not.
 *
 * @throws {LighterValidationError} `UNSAFE_INTEGER` for a non-integral `number`; `VALUE_TOO_LOW` or
 * `VALUE_TOO_HIGH` for an integer outside `[-2^63, 2^64)`.
 */
export function toField(v: bigint | number): Fp {
  const wide: bigint = widen(v);
  if (wide < I64_MIN) {
    throw new LighterValidationError(
      "VALUE_TOO_LOW",
      `toField: ${wide.toString()} < ${I64_MIN.toString()}`,
      { bound: I64_MIN },
    );
  }
  if (wide > U64_MAX) {
    throw new LighterValidationError(
      "VALUE_TOO_HIGH",
      `toField: ${wide.toString()} > ${U64_MAX.toString()}`,
      { bound: U64_MAX },
    );
  }
  const e: bigint = BigInt.asUintN(64, wide);
  // One conditional subtraction is exact: every 64-bit word is below 2p.
  return (e >= P ? e - P : e) as Fp;
}

/**
 * Split a value into `[low 32 bits, high 32 bits]` with a **logical** shift.
 *
 * The value is reinterpreted as an unsigned 64-bit word first, then both halves are taken from that
 * word, so both results are always in `[0, 2^32)` and no reduction is ever needed. Used by
 * `L2Transfer.Amount`, `L2Transfer.USDCFee` and `L2Withdraw.Amount`.
 *
 * `splitU64(-1n)` is `[4294967295n, 4294967295n]` — contrast {@link splitI64Arith}, whose high half
 * is `4294967294n` for the same input.
 *
 * @throws {LighterValidationError} as {@link toField}, for inputs outside `[-2^63, 2^64)`.
 */
export function splitU64(v: bigint): readonly [Fp, Fp] {
  // Range-check through toField before masking, so an out-of-domain value cannot be silently
  // truncated into two innocent-looking halves.
  toField(v);
  const u: bigint = BigInt.asUintN(64, v);
  return [toField(u & LOW32_MASK), toField(u >> 32n)] as const;
}

/**
 * Split a value into `[low 32 bits, high 32 bits]` with an **arithmetic** shift.
 *
 * Used by `L2UpdateMargin.USDCAmount`, and by nothing else.
 *
 * The order of operations is the whole point. The shift happens while the value is **still signed**,
 * so a negative input propagates its sign into the high half and that half is then reinterpreted by
 * {@link toField}:
 *
 * ```
 * splitI64Arith(-1n) -> [4294967295n, 4294967294n]
 * splitU64(-1n)      -> [4294967295n, 4294967295n]
 * ```
 *
 * Normalising to unsigned first and shifting afterwards yields `4294967295` for the high half,
 * which is what the reference does *not* produce. Pinned by `update_margin/negative_minus_one`,
 * `update_margin/negative_2_pow_32` and `update_margin/negative_realistic` in `tx.json`.
 *
 * JavaScript's `BigInt >>` is already an arithmetic shift with floor semantics on negatives
 * (`-1n >> 32n === -1n`, `-12345678901n >> 32n === -3n`), which matches Go's signed `>>`.
 *
 * @throws {LighterValidationError} as {@link toField}, for inputs outside `[-2^63, 2^64)`.
 */
export function splitI64Arith(v: bigint): readonly [Fp, Fp] {
  toField(v);
  // `v & 0xffffffffn` on a negative BigInt operates on the infinite two's-complement
  // representation, so the low half is already the unsigned low word: -1n & mask === 2^32 - 1.
  return [toField(v & LOW32_MASK), toField(v >> 32n)] as const;
}

/**
 * Decode a 40-byte public key into the 5 field elements the hasher absorbs.
 *
 * Limb `i` is the little-endian `uint64` at `bytes[8i .. 8i+8)`. Limbs are **reduced, not
 * rejected**: the reference's `FromCanonicalLittleEndianBytesF` is a raw `binary.LittleEndian.Uint64`
 * with no comparison against `p` (`docs/protocol-notes.md` §1, `spec/04-tx-types.md` §1.4), and
 * public-key derivation there genuinely returns limbs above the modulus — `SchnorrPkFromSk(1)`
 * yields `[ORDER+4, ORDER, ORDER, ORDER, ORDER]`. Rejecting a non-canonical limb would refuse a key
 * the sequencer accepts.
 *
 * Length is the only thing validated, because a wrong length is a framing error rather than a
 * representation choice.
 *
 * This returns a plain 5-tuple of `GF(p)` elements for the transaction hasher, deliberately not a
 * `GF(p^5)` value: the elements are absorbed individually into the element list, and routing them
 * through the extension-field type would imply an algebraic meaning they do not have here.
 *
 * @throws {LighterValidationError} `PUBKEY_INVALID` when `bytes.length !== 40`.
 */
export function pubKeyToFieldElements(bytes: Uint8Array): readonly [Fp, Fp, Fp, Fp, Fp] {
  if (bytes.length !== PUBKEY_BYTES) {
    throw new LighterValidationError(
      "PUBKEY_INVALID",
      `pubKeyToFieldElements: expected ${String(PUBKEY_BYTES)} bytes, got ${String(bytes.length)}`,
      { field: "PubKey" },
    );
  }
  return [
    fpFromBytesUnchecked(bytes.subarray(0, 8)),
    fpFromBytesUnchecked(bytes.subarray(8, 16)),
    fpFromBytesUnchecked(bytes.subarray(16, 24)),
    fpFromBytesUnchecked(bytes.subarray(24, 32)),
    fpFromBytesUnchecked(bytes.subarray(32, 40)),
  ] as const;
}
