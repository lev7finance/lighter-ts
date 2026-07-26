/**
 * The `tx_info` emitter — the exact JSON document `POST /api/v1/sendTx` carries.
 *
 * ## Why this is hand-rolled, and why that is not preciousness
 *
 * The built-in JSON stringifier **cannot be used here at all**, for two independent reasons
 * (`spec/04-tx-types.md` §9.3):
 *
 * 1. It throws on `bigint`, and `Index`, `ShareAmount`, `Amount`, `USDCFee`, `USDCAmount`,
 *    `OrderExpiry`, `Time` and `Nonce` are all `bigint` here because they all exceed `2^53`.
 * 2. Any round trip through `JSON.parse` silently rounds those same fields. `1152921504606846975`
 *    — a legal `MaxOrderIndex` — parses to `1152921504606847000`. That is not a rejected
 *    transaction; it is a *different* transaction, submitted with a signature over the original.
 *
 * A `replacer`/`reviver` pair could paper over (1) and cannot fix (2) for anything downstream, so
 * the emitter writes text directly from the schema and never builds an intermediate object.
 *
 * ## This is the one part of the codec with no vector behind it
 *
 * All 38 `txHashes` rows in `conformance/vectors/tx.json` carry `"txInfoJson": ""` — the Go oracle
 * does not emit the JSON. The tests here are golden strings written by hand from
 * `spec/04-tx-types.md` §9.2 (the encoding table) and §7 (the per-type key lists), and its only
 * end-to-end proof is the tagged live-testnet round-trip. Review changes to this file as protocol,
 * not as test fixtures.
 *
 * ## The rules, reproduced exactly (§9.2)
 *
 * | Source | JSON |
 * | --- | --- |
 * | any integer (`number` or `bigint`) | decimal number, unquoted, never exponent notation |
 * | `Uint8Array` under `bytesB64` / `gfp5` (`Sig`, `PubKey`) | base64, standard alphabet, `=`-padded |
 * | `Uint8Array` under `byteArray` (`Memo`) | array of `len` numbers, `[0,0,…]` |
 * | `string` under `hexString` (`L1Sig`) | JSON string, `0x`-prefixed lowercase hex |
 * | attribute map | `{"1":42,"4":1}`, decimal-string keys ascending |
 * | absent attribute map | `null` |
 *
 * Three consequences worth stating outright:
 *
 * - **Nothing uses `omitempty`.** Every declared key is always present, including zero values and
 *   `null`. {@link readTxField} turns an absent property into an error rather than a skipped key.
 * - **`SignedHash` is never emitted.** It is `json:"-"` in the reference and is returned to the
 *   caller out-of-band as the transaction hash. It is not a schema field, so it cannot leak in.
 * - **Key order is Go declaration order.** JSON objects are unordered, so this is not semantically
 *   load-bearing — but it is what the per-type tables specify and it makes golden diffs readable.
 *   `L2TxAttributes` is always last.
 *
 * The `gfp5` asymmetry deserves its own line: five field elements go into the hash, and the
 * **original 40 bytes** go into the JSON as base64. Re-serialising the reduced elements would
 * corrupt any public key with a limb above the modulus, which real keys have
 * (`docs/protocol-notes.md` §1).
 */

import { LighterValidationError } from "../errors.js";
import { bytesToBase64 } from "../util/bytes.js";
import { attributesToJson } from "./attributes.js";
import { PUBKEY_LENGTH } from "./constants.js";
import {
  ATTRIBUTES_JSON_KEY,
  type Enc,
  type FieldSpec,
  type TxLike,
  type TxSchema,
  readTxField,
} from "./schema.js";

/**
 * Write an integer as Go's `encoding/json` would: decimal digits, unquoted, no exponent.
 *
 * `bigint` goes through `toString(10)`, which is exact at any width. A `number` is checked for safe
 * integrality first — `String` on a safe integer never produces exponent notation (that starts at
 * `1e21`, well beyond `2^53`) and never produces a fraction, so the check is what makes the format
 * guarantee hold rather than a coincidence.
 *
 * @throws {LighterValidationError} `UNSAFE_INTEGER` for a non-integral or unsafe `number`,
 * `FIELD_TYPE_INVALID` for anything that is not a number or bigint.
 */
function integerJson(value: unknown, name: string): string {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new LighterValidationError(
        "UNSAFE_INTEGER",
        `field '${name}': ${String(value)} is not a safe integer; pass a bigint for values beyond 2^53 - 1`,
        { field: name },
      );
    }
    // `String(-0)` is "0", which is what Go emits for a negative zero float-free integer too.
    return String(value);
  }
  throw new LighterValidationError(
    "FIELD_TYPE_INVALID",
    `field '${name}': expected a bigint or number, got ${typeof value}`,
    { field: name },
  );
}

/**
 * Narrow to a `Uint8Array` of exactly `len` bytes.
 *
 * The length check is not defensive padding: base64 of 79 bytes is a well-formed string that the
 * sequencer will reject as a bad signature, and diagnosing that from a 403 is expensive.
 */
function bytesOfLength(value: unknown, name: string, len: number): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new LighterValidationError(
      "FIELD_TYPE_INVALID",
      `field '${name}': expected a Uint8Array, got ${typeof value}`,
      { field: name },
    );
  }
  if (value.length !== len) {
    throw new LighterValidationError(
      "FIELD_LENGTH_INVALID",
      `field '${name}': expected ${String(len)} bytes, got ${String(value.length)}`,
      { field: name },
    );
  }
  return value;
}

/**
 * `[0,0,…]` — a Go `[32]byte` **array**, which `encoding/json` writes as a number list, unlike a
 * `[]byte` **slice**, which it writes as base64. `Memo` is the array; `Sig` and `PubKey` are slices.
 * The distinction is invisible in Go source at the use site and is the whole reason `byteArray` and
 * `bytesB64` are separate encodings here.
 */
function byteArrayJson(bytes: Uint8Array): string {
  let out: string = "[";
  for (let i: number = 0; i < bytes.length; i += 1) {
    if (i > 0) out += ",";
    out += String(bytes[i] as number);
  }
  return out + "]";
}

/**
 * A `0x`-prefixed lowercase hex string, emitted as a JSON string.
 *
 * The charset is validated rather than escaped: once the value is known to be `0x` followed by
 * lowercase hex digits, there is no character in it that JSON string syntax would need to escape,
 * so this function cannot silently emit an unescaped quote or control character. An odd number of
 * digits means a truncated signature and is rejected here.
 */
function hexStringJson(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new LighterValidationError(
      "FIELD_TYPE_INVALID",
      `field '${name}': expected a string, got ${typeof value}`,
      { field: name },
    );
  }
  const body: string = value.startsWith("0x") ? value.slice(2) : "";
  const wellFormed: boolean =
    value.startsWith("0x") && body.length % 2 === 0 && /^[0-9a-f]*$/.test(body);
  if (!wellFormed) {
    throw new LighterValidationError(
      "HEX_STRING_INVALID",
      `field '${name}': expected a 0x-prefixed lowercase hex string with an even number of digits`,
      { field: name },
    );
  }
  return `"${value}"`;
}

/** The JSON value text for one field — no key, no comma, no surrounding whitespace. */
function encodeJsonField(field: FieldSpec, value: unknown): string {
  const enc: Enc = field.enc;
  switch (enc.k) {
    // A split field is two elements in the hash and one plain number in the JSON: the split is an
    // absorption detail and never reaches the wire.
    case "int":
    case "splitU64":
    case "splitI64Arith":
      return integerJson(value, field.name);
    case "gfp5":
      return `"${bytesToBase64(bytesOfLength(value, field.name, PUBKEY_LENGTH))}"`;
    case "bytesB64":
      return `"${bytesToBase64(bytesOfLength(value, field.name, enc.len))}"`;
    case "byteArray":
      return byteArrayJson(bytesOfLength(value, field.name, enc.len));
    case "hexString":
      return hexStringJson(value, field.name);
    case "custom":
      return enc.json(value);
  }
}

/**
 * The complete `tx_info` document for a transaction.
 *
 * Walks `schema.fields` in declaration order, then appends `L2TxAttributes` last. The result always
 * starts with `{` — the reference uses that as its sanity gate on the submission path
 * (`spec/04-tx-types.md` §9.1).
 *
 * @throws {LighterValidationError} for an absent, mistyped, or malformed field, or an invalid
 * attribute map.
 */
export function serializeTx(schema: TxSchema, tx: TxLike): string {
  const parts: string[] = [];
  for (const field of schema.fields) {
    parts.push(`"${field.json}":${encodeJsonField(field, readTxField(tx, field.name))}`);
  }
  parts.push(`"${ATTRIBUTES_JSON_KEY}":${attributesToJson(tx.attributes)}`);
  return `{${parts.join(",")}}`;
}
