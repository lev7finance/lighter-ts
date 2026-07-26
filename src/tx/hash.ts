/**
 * The one transaction hasher. Every transaction type goes through it; none has a `hash` method.
 *
 * ## The shape
 *
 * `docs/protocol-notes.md` §3.3 and `spec/04-tx-types.md` §5:
 *
 * ```
 * elements = [ chainId, txType, Nonce, ExpiredAt, ...hashOrder.flatMap(encode) ]
 * txHash   = hashToQuinticExtension(elements)          // GF(p^5)
 * message  = aggregateTxHash(txHash, tx.attributes)    // 40 little-endian bytes
 * ```
 *
 * Those four prefix elements are emitted here and are **not** in `schema.hashOrder`; see
 * `schema.ts` for why the JSON order and the absorption order are two lists. `hashOrder` then
 * begins at the account-index field, so absorbed positions 4 and 5 are the account index and the
 * api-key index for every constructible type — by field name, from the schema, never by a
 * hard-coded property lookup.
 *
 * ## Two details that are easy to get subtly wrong
 *
 * **Element 1 comes from `schema.txType`, not from the transaction object.** They are equal by
 * construction, and reading it from exactly one place removes the class of bug where a builder sets
 * a `type` discriminant that disagrees with the table driving the encoding — which would sign one
 * transaction and submit it as another.
 *
 * **The aggregation step runs unconditionally**, including for transactions with no attributes at
 * all. With an empty attribute set it serialises the hash to 40 little-endian bytes and stops; it
 * does not re-hash (`src/tx/attributes.ts`, first `attributeHashes` vector row). Skipping the call
 * for the empty case happens to give the same answer today only because that function is written
 * that way — call it always and there is nothing to keep in sync.
 *
 * ## What this returns
 *
 * 40 bytes. That is the message the Schnorr signer signs, and its lowercase hex — 80 characters, no
 * `0x` — is the `SignedHash` the reference returns to the caller out-of-band. `SignedHash` is never
 * part of `tx_info`.
 */

import { LighterValidationError } from "../errors.js";
import type { Fp } from "../crypto/field/fp.js";
import type { Fp5 } from "../crypto/field/fp5.js";
import { hashToQuinticExtension } from "../crypto/poseidon2/index.js";
import { bytesToHex } from "../util/bytes.js";
import { aggregateTxHash } from "./attributes.js";
import { pubKeyToFieldElements, splitI64Arith, splitU64, toField } from "./field-encode.js";
import {
  type Enc,
  type FieldSpec,
  type TxLike,
  type TxSchema,
  readTxField,
  schemaField,
} from "./schema.js";

/**
 * Coerce a declared integer field to `bigint` without ever rounding.
 *
 * `toField` accepts `bigint | number` directly, but the split encodings need a `bigint` to shift,
 * and `BigInt(1.5)` throws with a message that names neither the field nor the transaction. Doing
 * the narrowing here means every bad value reports which field it came from.
 *
 * @throws {LighterValidationError} `FIELD_TYPE_INVALID` for a non-numeric value, `UNSAFE_INTEGER`
 * for a `number` that is not a safe integer.
 */
function fieldToBigInt(value: unknown, name: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new LighterValidationError(
        "UNSAFE_INTEGER",
        `field ${JSON.stringify(name)}: ${String(value)} is not a safe integer; pass a bigint for values beyond 2^53 - 1`,
        { field: name },
      );
    }
    return BigInt(value);
  }
  throw new LighterValidationError(
    "FIELD_TYPE_INVALID",
    `field ${JSON.stringify(name)}: expected a bigint or number, got ${typeof value}`,
    { field: name },
  );
}

/** Narrow to `Uint8Array`, naming the field. */
function fieldToBytes(value: unknown, name: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new LighterValidationError(
    "FIELD_TYPE_INVALID",
    `field ${JSON.stringify(name)}: expected a Uint8Array, got ${typeof value}`,
    { field: name },
  );
}

/**
 * Project one field into the elements it contributes, in order.
 *
 * The encoding decides the count — one element, two, five, or whatever a `custom` projection
 * returns. Nothing here infers a split from a value's magnitude: `BaseAmount` reaches `2^48 - 1`
 * and `OrderExpiry` is a millisecond timestamp, and neither splits, while `L2Transfer.USDCFee`
 * splits at any size (`docs/protocol-notes.md` §3.2). The schema declares it; the value never does.
 */
function encodeHashField(field: FieldSpec, value: unknown): readonly Fp[] {
  const enc: Enc = field.enc;
  switch (enc.k) {
    case "int":
      return [toField(fieldToBigInt(value, field.name))];
    case "splitU64":
      return splitU64(fieldToBigInt(value, field.name));
    case "splitI64Arith":
      return splitI64Arith(fieldToBigInt(value, field.name));
    case "gfp5":
      return pubKeyToFieldElements(fieldToBytes(value, field.name));
    case "custom":
      return enc.elements(value);
    case "bytesB64":
    case "byteArray":
    case "hexString":
      // Unreachable through `defineTxSchema`, which rejects these in `hashOrder`. Kept because a
      // hand-built schema literal skips that check, and a silently-dropped field would change the
      // hash of every transaction of that type.
      throw new LighterValidationError(
        "SCHEMA_INVALID",
        `field ${JSON.stringify(field.name)} has JSON-only encoding ${enc.k} and cannot be hashed`,
        { field: field.name },
      );
  }
}

/**
 * The full ordered element list absorbed for a transaction, prefix included.
 *
 * Exported because it is the only view that makes a hash mismatch debuggable: comparing element
 * lists against the reference localises the fault to a field, where comparing 40-byte digests
 * localises it to "somewhere in the transaction".
 */
export function txHashElements(schema: TxSchema, tx: TxLike, chainId: number): readonly Fp[] {
  const elements: Fp[] = [
    toField(chainId),
    toField(schema.txType),
    toField(fieldToBigInt(tx.nonce, "nonce")),
    toField(fieldToBigInt(tx.expiredAt, "expiredAt")),
  ];
  for (const name of schema.hashOrder) {
    const field: FieldSpec = schemaField(schema, name);
    const encoded: readonly Fp[] = encodeHashField(field, readTxField(tx, name));
    for (const e of encoded) elements.push(e);
  }
  return elements;
}

/**
 * The 40-byte message a transaction is signed over.
 *
 * @throws {LighterValidationError} for a malformed field or an invalid attribute map.
 */
export function hashTx(schema: TxSchema, tx: TxLike, chainId: number): Uint8Array {
  const digest: Fp5 = hashToQuinticExtension(txHashElements(schema, tx, chainId));
  return aggregateTxHash(digest, tx.attributes);
}

/**
 * {@link hashTx} as lowercase hex: 80 characters, **no `0x` prefix**.
 *
 * This is the reference's `SignedHash` and the `txHash` the API returns, so the absent prefix is
 * interop, not style — it is compared against server responses as a string.
 */
export function hashTxHex(schema: TxSchema, tx: TxLike, chainId: number): string {
  return bytesToHex(hashTx(schema, tx, chainId));
}
