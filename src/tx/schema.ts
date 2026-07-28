/**
 * The declarative vocabulary every transaction type is described in, and from which both the hash
 * and the `tx_info` JSON are derived.
 *
 * ## Why this exists
 *
 * The Go reference needs three edits to add a transaction type — a struct, a `Hash` method and a
 * `Validate` method — plus a fourth in its client and a fifth in the FFI shim. Five hand-written
 * sites per type, twenty types. That duplication is the direct cause of its copy-pasted error
 * identities (`spec/04-tx-types.md` §7.11, §7.15) and of its divergent lo/hi split rules
 * (`docs/protocol-notes.md` §3.2). Here a transaction type is **one table**: {@link txHashElements}
 * and {@link serializeTx} both read it, so the bytes that were signed and the bytes that go on the
 * wire cannot describe different transactions.
 *
 * ## The two lists are not one list
 *
 * {@link TxSchema} carries two orderings and they are deliberately different:
 *
 * - `fields` is **JSON emission order** — Go struct declaration order, which is what the per-type
 *   tables in `spec/04-tx-types.md` §7 specify.
 * - `hashOrder` is **absorption order**, and it starts *after* the universal prefix
 *   `[chainId, txType, Nonce, ExpiredAt]` that the hasher emits by itself.
 *
 * So `Nonce` and `ExpiredAt` appear in `fields` (they are JSON keys) and **not** in `hashOrder`
 * (the hasher already emitted them, in a different position). `Sig`, `L1Sig` and `Memo` appear only
 * in `fields`: none of the three is hashed, and `Memo` in particular is bound only by the L1
 * signature. Collapsing the two lists into a single ordered list is precisely the mistake this
 * design exists to prevent, and it is a mistake that produces a valid-looking hash for every
 * transaction and a rejected signature for all of them.
 *
 * `hashOrder`'s first entry is the account-index field, whose *property name* differs per type —
 * `accountIndex` on most types, `fromAccountIndex` on Transfer and Withdraw. Position 4 is the
 * account index and position 5 the api-key index for every constructible type, but that is a
 * property of the schemas, not something this module hard-codes.
 *
 * ## Ownership
 *
 * This module is the vocabulary only. It deliberately imports nothing from `src/tx/schemas/**` —
 * the per-type tables import *this*, and the registry of them lives with them
 * ({@link createTxSchemaRegistry} is handed the list; it does not go looking for one). A module-level
 * mutable registry here would make schema availability depend on import order.
 */

import { LighterValidationError } from "../errors.js";
import type { Fp } from "../crypto/field/fp.js";
import type { TxAttributes } from "./attributes.js";
import type { TxTypeCode } from "./enums.js";

/**
 * How one field turns into hash elements, into JSON, or into both.
 *
 * The asymmetry is the point: several encodings contribute to exactly one of the two projections.
 *
 * | Variant | Hash | JSON |
 * | --- | --- | --- |
 * | `int` | one element, {@link toField} | decimal number |
 * | `splitU64` | two elements, logical high shift | decimal number (the whole value) |
 * | `splitI64Arith` | two elements, arithmetic high shift | decimal number (the whole value) |
 * | `gfp5` | five elements from 40 bytes | base64 of those same 40 bytes |
 * | `bytesB64` | — | base64 |
 * | `byteArray` | — | array of `len` numbers |
 * | `hexString` | — | `0x`-prefixed lowercase hex string |
 * | `custom` | caller-supplied | caller-supplied |
 *
 * `gfp5` is the one that catches people: five elements go into the sponge, but the JSON carries the
 * **original bytes** re-encoded as base64, not a re-serialisation of the reduced elements. Limbs
 * above the modulus exist in real public keys (`docs/protocol-notes.md` §1), so those two are not
 * the same 40 bytes.
 *
 * `spec/04-tx-types.md` §13.3 sketches this union with an extra `{k:'orders'}` variant for
 * `L2CreateGroupedOrders`. It is **not** implemented here: `{k:'orders'}` would force this module to
 * import `src/tx/grouped-hash.ts`, which imports this module — an import cycle for the sake of one
 * transaction type. The grouped-orders unit supplies its leaf-hash fold and its JSON array writer
 * through `{k:'custom'}` instead, which is the same behaviour with the dependency arrow pointing
 * one way.
 */
export type Enc =
  | { readonly k: "int" }
  | { readonly k: "splitU64" }
  | { readonly k: "splitI64Arith" }
  | { readonly k: "gfp5" }
  | { readonly k: "bytesB64"; readonly len: number }
  | { readonly k: "byteArray"; readonly len: number }
  | { readonly k: "hexString" }
  | {
      readonly k: "custom";
      /** Elements absorbed for this field, in order. Called only if the field is in `hashOrder`. */
      elements(value: unknown): readonly Fp[];
      /** The exact JSON value text for this field — no surrounding key, no comma. */
      json(value: unknown): string;
    };

/** One field of one transaction type. */
export interface FieldSpec {
  /** Property name on the transaction object. Referenced by {@link TxSchema.hashOrder}. */
  readonly name: string;
  /** Exact wire key, PascalCase. Never derived from {@link name} — the two genuinely differ. */
  readonly json: string;
  /** How the value is projected into elements and/or JSON. */
  readonly enc: Enc;
}

/** The complete description of one transaction type. */
export interface TxSchema {
  /** The `tx_type` code. The hasher reads element 1 from here, never from the transaction object. */
  readonly txType: TxTypeCode;
  /** JSON emission order. `L2TxAttributes` is appended by the serialiser and is not listed here. */
  readonly fields: readonly FieldSpec[];
  /** Absorption order **after** the universal `[chainId, txType, Nonce, ExpiredAt]` prefix. */
  readonly hashOrder: readonly string[];
}

/**
 * The minimum a transaction object must offer to be hashed or serialised.
 *
 * Written as a type alias rather than an interface on purpose: an interface would force every
 * concrete transaction type to restate an index signature to stay assignable. Field access goes
 * through {@link readTxField}, which casts once, in one place, with a real error when the property
 * is absent.
 *
 * `nonce` and `expiredAt` are named here because the hasher needs them positionally, before any
 * schema field. They also appear in `fields` as `Nonce` and `ExpiredAt` for JSON.
 */
export type TxLike = {
  readonly nonce: bigint | number;
  readonly expiredAt: bigint | number;
  readonly attributes?: TxAttributes | undefined;
};

/**
 * Whether an encoding can appear in {@link TxSchema.hashOrder}.
 *
 * `bytesB64`, `byteArray` and `hexString` are JSON-only by protocol, not by omission: `Sig` cannot
 * be inside the hash it signs, `L1Sig` is produced from a different message entirely, and `Memo` is
 * deliberately excluded from the L2 hash and bound only by the L1 signature.
 */
export function isHashable(enc: Enc): boolean {
  switch (enc.k) {
    case "int":
    case "splitU64":
    case "splitI64Arith":
    case "gfp5":
    case "custom":
      return true;
    case "bytesB64":
    case "byteArray":
    case "hexString":
      return false;
  }
}

/**
 * Resolve a field by property name.
 *
 * Linear over a list that is at most ~16 entries and is dwarfed by one Poseidon2 permutation, so
 * there is no index to keep in sync and no cache to invalidate.
 *
 * @throws {LighterValidationError} `SCHEMA_FIELD_UNKNOWN` when the name is not declared.
 */
export function schemaField(schema: TxSchema, name: string): FieldSpec {
  for (const f of schema.fields) {
    if (f.name === name) return f;
  }
  throw new LighterValidationError(
    "SCHEMA_FIELD_UNKNOWN",
    `tx type ${String(schema.txType)}: no field named ${JSON.stringify(name)} in the schema`,
    { field: name },
  );
}

/**
 * Read a declared field off a transaction object.
 *
 * Nothing in the protocol uses `omitempty` — every declared key is always present, including zero
 * values — so an absent property is a construction bug, and silently emitting `0` or `null` for it
 * would produce a transaction that hashes and serialises and means something else.
 *
 * @throws {LighterValidationError} `FIELD_MISSING` when the property is absent or nullish.
 */
export function readTxField(tx: TxLike, name: string): unknown {
  const value: unknown = (tx as unknown as Record<string, unknown>)[name];
  if (value === undefined || value === null) {
    throw new LighterValidationError(
      "FIELD_MISSING",
      `transaction is missing declared field ${JSON.stringify(name)}`,
      { field: name },
    );
  }
  return value;
}

/** The wire key the attribute map is emitted under. Always last, always present, never in `fields`. */
export const ATTRIBUTES_JSON_KEY: "L2TxAttributes" = "L2TxAttributes";

/**
 * Check a schema's internal consistency once, at definition time, and freeze it.
 *
 * Schema units are expected to wrap their tables in this. Every condition it checks is one that
 * would otherwise surface as a wrong hash or a malformed body at runtime:
 *
 * - a duplicate property name makes {@link schemaField} resolve to whichever came first;
 * - a duplicate JSON key emits the same wire key twice, and a Go decoder keeps the last;
 * - a `hashOrder` entry with no matching field silently drops elements from the hash;
 * - a repeated `hashOrder` entry absorbs a field twice;
 * - a JSON-only encoding in `hashOrder` (`Sig`, `L1Sig`, `Memo`) is never legal — see
 *   {@link isHashable}.
 *
 * @throws {LighterValidationError} `SCHEMA_INVALID` (or `SCHEMA_FIELD_UNKNOWN` via
 * {@link schemaField}) describing the first inconsistency found.
 */
export function defineTxSchema(schema: TxSchema): TxSchema {
  const seenNames: Set<string> = new Set<string>();
  const seenJson: Set<string> = new Set<string>();
  for (const f of schema.fields) {
    if (seenNames.has(f.name)) {
      throw new LighterValidationError(
        "SCHEMA_INVALID",
        `tx type ${String(schema.txType)}: duplicate field name ${JSON.stringify(f.name)}`,
        { field: f.name },
      );
    }
    if (seenJson.has(f.json)) {
      throw new LighterValidationError(
        "SCHEMA_INVALID",
        `tx type ${String(schema.txType)}: duplicate JSON key ${JSON.stringify(f.json)}`,
        { field: f.json },
      );
    }
    if (f.json === ATTRIBUTES_JSON_KEY) {
      throw new LighterValidationError(
        "SCHEMA_INVALID",
        `tx type ${String(schema.txType)}: ${ATTRIBUTES_JSON_KEY} is emitted by the serialiser and must not be a declared field`,
        { field: f.json },
      );
    }
    seenNames.add(f.name);
    seenJson.add(f.json);
  }

  const seenHash: Set<string> = new Set<string>();
  for (const name of schema.hashOrder) {
    const f: FieldSpec = schemaField(schema, name);
    if (seenHash.has(name)) {
      throw new LighterValidationError(
        "SCHEMA_INVALID",
        `tx type ${String(schema.txType)}: ${JSON.stringify(name)} appears twice in hashOrder`,
        { field: name },
      );
    }
    if (!isHashable(f.enc)) {
      throw new LighterValidationError(
        "SCHEMA_INVALID",
        `tx type ${String(schema.txType)}: field ${JSON.stringify(name)} has JSON-only encoding ${f.enc.k} and cannot be hashed`,
        { field: name },
      );
    }
    seenHash.add(name);
  }

  return Object.freeze({
    txType: schema.txType,
    fields: Object.freeze(schema.fields.slice()),
    hashOrder: Object.freeze(schema.hashOrder.slice()),
  });
}

/** A `txType -> schema` lookup. Built by the schema modules; this one only knows the shape. */
export type TxSchemaRegistry = ReadonlyMap<TxTypeCode, TxSchema>;

/**
 * Build a registry from a list of schemas.
 *
 * The list is supplied by the caller rather than accumulated in module state, so a schema is
 * reachable because someone imported it, not because a side effect happened to run first.
 *
 * @throws {LighterValidationError} `SCHEMA_INVALID` if two schemas claim the same `txType`.
 */
export function createTxSchemaRegistry(schemas: readonly TxSchema[]): TxSchemaRegistry {
  const map: Map<TxTypeCode, TxSchema> = new Map<TxTypeCode, TxSchema>();
  for (const schema of schemas) {
    if (map.has(schema.txType)) {
      throw new LighterValidationError(
        "SCHEMA_INVALID",
        `duplicate schema for tx type ${String(schema.txType)}`,
      );
    }
    map.set(schema.txType, schema);
  }
  return map;
}

/**
 * Look a schema up, failing loudly.
 *
 * @throws {LighterValidationError} `SCHEMA_TX_TYPE_UNKNOWN` when the code has no schema — which for
 * a caller-supplied `txType` means "this transaction type is not constructible by this SDK", not
 * "it does not exist".
 */
export function requireTxSchema(registry: TxSchemaRegistry, txType: TxTypeCode): TxSchema {
  const schema: TxSchema | undefined = registry.get(txType);
  if (schema === undefined) {
    throw new LighterValidationError(
      "SCHEMA_TX_TYPE_UNKNOWN",
      `no transaction schema registered for tx type ${String(txType)}`,
    );
  }
  return schema;
}
