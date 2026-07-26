/**
 * `L2TxAttributes` — the optional side-channel carried by every Lighter transaction, and the
 * aggregation step that turns a raw transaction hash into the 40 bytes that actually get signed.
 *
 * An attribute set is a sparse map of at most **four** `attributeType -> value` entries. It exists
 * so the protocol can add per-transaction knobs — integrator fees, nonce skipping, per-market
 * cancel-all, self-trade policy — without minting a new transaction type. This module owns the
 * registry, the validation rules, the normalisation, the attribute hash, the aggregation, and the
 * JSON emitter.
 *
 * ## Why a mistake here is expensive
 *
 * {@link aggregateTxHash} is the **last line of every transaction's `hash()`**, including
 * transactions that carry no attributes at all. All 20 transaction types route through it, so a
 * defect here does not fail one type — it fails all of them, and it fails them as "the sequencer
 * rejected my signature", which reads as a crypto bug rather than a codec bug.
 *
 * Four things are counter-intuitive and each is pinned by `conformance/vectors/tx.json` ->
 * `attributeHashes`:
 *
 * 1. **The empty case does not re-hash.** With no (non-nil) attributes, aggregation serialises the
 *    transaction hash to 40 little-endian bytes and stops. Hashing it a second time "for
 *    uniformity" is wrong. First vector row, `isEmpty: true`.
 * 2. **The padding zeros still contribute.** The absorb list is always exactly 8 elements —
 *    `[type, value]` for all four slots, including the `[0, 0]` pairs. Absorbing only the populated
 *    slots yields a different hash for every attributed transaction.
 * 3. **`combined` is transaction hash first, attribute hash second** — 10 elements, i.e. two sponge
 *    blocks (8 + 2) with no padding. If the 10-element case disagrees with the vectors, suspect the
 *    sponge's partial-block rule (`docs/protocol-notes.md` §2), not this file.
 * 4. **`CancelAllMarketIndex`'s nil value is `255`, not `0`.** `{5: 0}` means market 0 and is *not*
 *    empty; `{5: 255}` is nil and *is* empty. Type 5's legal range includes its own nil value.
 *
 * ## Emptiness is a value predicate, not a size predicate
 *
 * `isEmpty` means "every present entry equals its registry nil value", so `{6: 0}` hashes exactly
 * as `{}` does. This SDK drops nil-valued entries at construction
 * (`spec/04-tx-types.md` §15 deviation #1), which makes the two coincide *after*
 * {@link normalizeAttributes} — but {@link attributesAreEmpty} is still correct for a
 * caller-supplied map that has never been normalised, because callers exist that build the map by
 * hand.
 *
 * ## Values are `number`, deliberately
 *
 * The largest legal attribute value is `281474976710654 < 2^53`, so every attribute value is a
 * safe integer and `number` is the honest type — it is also what the wire uses. This is the
 * documented exception to the house rule against `number`; nothing monetary passes through here.
 * The JSON emitter therefore never prints an `n` suffix or exponent notation.
 *
 * No Node built-ins, no dependencies.
 *
 * @see `docs/spec/04-tx-types.md` §6 (registry, validation, hashing), §12 (error identities)
 * @see `docs/protocol-notes.md` §3.3 (hash shape and attribute normalisation)
 */

import { LighterValidationError, type LighterValidationCode } from "../errors.js";
import type { Fp } from "../crypto/field/fp.js";
import { type Fp5, fp5ToBytes } from "../crypto/field/fp5.js";
import { hashToQuinticExtension } from "../crypto/poseidon2/index.js";
import { toField } from "./field-encode.js";

/** The number of attribute slots a transaction has. `NbAttributesPerTx` in the reference. */
export const NB_ATTRIBUTES_PER_TX: 4 = 4;

/** Largest defined attribute type. Type `0` is reserved as the padding sentinel. */
export const MAX_ATTRIBUTE_TYPE: 7 = 7;

/** The seven defined attribute types. `0` is the padding sentinel and is not one of them. */
export type AttributeType = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * A sparse attribute map: at most {@link NB_ATTRIBUTES_PER_TX} entries.
 *
 * Absent (`undefined`) and empty (`{}`) are equivalent everywhere in this module, and both serialise
 * to the JSON literal `null`.
 */
export type TxAttributes = Readonly<Partial<Record<AttributeType, number>>>;

/**
 * One row of the attribute registry.
 *
 * The reference's `ByteSize` column is deliberately absent: it is the sequencer's packed-encoding
 * width, the SDK never uses it, and porting it would be cargo-culting.
 */
export interface AttributeSpec {
  /** The wire type code. */
  readonly type: AttributeType;
  /** The reference's Go identifier, used in diagnostics. */
  readonly name: string;
  /** Smallest legal value, inclusive. */
  readonly min: number;
  /** Largest legal value, inclusive. */
  readonly max: number;
  /** The value that means "unset". Not always `0` — see type 5. */
  readonly nil: number;
  /** The validation code raised when the value falls outside `[min, max]`. */
  readonly rangeErrorCode: LighterValidationCode;
}

/**
 * The seven attribute types, from `spec/04-tx-types.md` §6.1.
 *
 * Two rows are irregular and both are load-bearing:
 *
 * - `CancelAllMarketIndex` (type 5) nils at `255`, not `0`, and `255` is *inside* its legal range.
 *   `{5: 0}` therefore means market 0 and is not empty.
 * - `SkipTxNonce` (type 4) nils at `0` while its range is `[1, 1]`, so its nil value is *outside*
 *   its own range. `{4: 0}` is simultaneously dropped by {@link normalizeAttributes} and rejected
 *   by {@link validateAttributes} — both matching the reference, which range-checks the raw map.
 *   The option constructor never emits it (§6.7 includes type 4 only when the value is `1`), so
 *   the two rules never collide in practice.
 */
export const ATTRIBUTE_REGISTRY: Readonly<Record<AttributeType, AttributeSpec>> = Object.freeze({
  1: Object.freeze({
    type: 1,
    name: "IntegratorAccountIndex",
    min: 0,
    max: 281474976710654,
    nil: 0,
    rangeErrorCode: "INTEGRATOR_ACCOUNT_INDEX_RANGE",
  }),
  2: Object.freeze({
    type: 2,
    name: "IntegratorTakerFee",
    min: 0,
    max: 1000000,
    nil: 0,
    rangeErrorCode: "INTEGRATOR_FEE_RANGE",
  }),
  3: Object.freeze({
    type: 3,
    name: "IntegratorMakerFee",
    min: 0,
    max: 1000000,
    nil: 0,
    rangeErrorCode: "INTEGRATOR_FEE_RANGE",
  }),
  4: Object.freeze({
    type: 4,
    name: "SkipTxNonce",
    min: 1,
    max: 1,
    nil: 0,
    rangeErrorCode: "NONCE_SKIP_ATTRIBUTE_INVALID",
  }),
  5: Object.freeze({
    type: 5,
    name: "CancelAllMarketIndex",
    min: 0,
    max: 255,
    nil: 255,
    rangeErrorCode: "CANCEL_ALL_MARKET_INDEX_RANGE",
  }),
  6: Object.freeze({
    type: 6,
    name: "SelfTradeBehaviorMode",
    min: 0,
    max: 3,
    nil: 0,
    rangeErrorCode: "SELF_TRADE_BEHAVIOR_MODE_RANGE",
  }),
  7: Object.freeze({
    type: 7,
    name: "SelfTradeEqualityMode",
    min: 0,
    max: 1,
    nil: 0,
    rangeErrorCode: "SELF_TRADE_EQUALITY_MODE_RANGE",
  }),
} satisfies Record<AttributeType, AttributeSpec>);

/**
 * Message text for each range error, verbatim from `spec/04-tx-types.md` §12.
 *
 * Kept beside the registry rather than inside {@link AttributeSpec} because the same message backs
 * two types (`INTEGRATOR_FEE_RANGE` covers both the taker and the maker fee) and duplicating a
 * string in two registry rows invites them to drift apart.
 */
const RANGE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  INTEGRATOR_ACCOUNT_INDEX_RANGE: "IntegratorAccountIndex is in invalid range",
  INTEGRATOR_FEE_RANGE: "Integrator fees are in invalid range",
  NONCE_SKIP_ATTRIBUTE_INVALID: "Nonce skip attribute is invalid",
  CANCEL_ALL_MARKET_INDEX_RANGE: "Cancel all for market index attribute is in invalid range",
  SELF_TRADE_BEHAVIOR_MODE_RANGE: "SelfTradeBehaviorMode is in invalid range",
  SELF_TRADE_EQUALITY_MODE_RANGE: "SelfTradeEqualityMode is in invalid range",
});

/** `SelfTradeBehaviorMode` value that means "reduce". Incompatible with {@link EQUALITY_MODE_MAI}. */
const BEHAVIOR_MODE_REDUCE: 3 = 3;

/** `SelfTradeEqualityMode` value that means "master account index". */
const EQUALITY_MODE_MAI: 1 = 1;

/** A `[type, value]` pair read off a caller-supplied map, before any type validation. */
type RawEntry = readonly [type: number, value: number];

/**
 * Read a caller-supplied map into `[type, value]` pairs without validating anything.
 *
 * Entries whose value is `undefined` are skipped: under `exactOptionalPropertyTypes` an optional
 * property that is explicitly `undefined` is not assignable, but plain JavaScript callers still
 * produce `{1: undefined}`, and "present but undefined" must mean the same thing as "absent" or the
 * hash and the size check disagree with the JSON.
 *
 * Types are parsed but not checked here, because {@link validateAttributes} must report
 * `TOO_MANY_ATTRIBUTES` *before* it reports an unknown type, per §6.2's ordering.
 */
function rawEntries(a?: TxAttributes): RawEntry[] {
  if (a === undefined || a === null) return [];
  const record = a as Readonly<Record<string, number | undefined>>;
  const out: RawEntry[] = [];
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value === undefined) continue;
    out.push([Number(key), value]);
  }
  return out;
}

/**
 * Look up a registry row, rejecting anything that is not one of the seven defined types.
 *
 * Unknown types throw rather than being ignored. Ignoring one would let a typo'd map hash as though
 * the attribute were absent and then be rejected by the sequencer, which is the failure mode this
 * module exists to prevent.
 *
 * @throws {LighterValidationError} `ATTRIBUTE_TYPE_INVALID`, message carrying the offending type.
 */
function specOf(type: number): AttributeSpec {
  const spec: AttributeSpec | undefined = Number.isInteger(type)
    ? (ATTRIBUTE_REGISTRY as Readonly<Record<number, AttributeSpec | undefined>>)[type]
    : undefined;
  if (spec === undefined) {
    throw new LighterValidationError(
      "ATTRIBUTE_TYPE_INVALID",
      `Attribute type is invalid: ${String(type)}`,
      { field: "Attributes" },
    );
  }
  return spec;
}

/**
 * Drop every entry whose value equals its registry nil value.
 *
 * This is `spec/04-tx-types.md` §15 deviation #1 made concrete: the reference's Go API keeps
 * nil-valued entries in the JSON while the hash ignores them, so the two disagree; its FFI shim
 * drops them. This SDK always drops them, which is a strict subset of accepted behaviour and makes
 * the emitted JSON match what was actually hashed.
 *
 * Keys are inserted in ascending numeric order, so a downstream `JSON.stringify` sees the same
 * ordering {@link attributesToJson} produces.
 *
 * @throws {LighterValidationError} `ATTRIBUTE_TYPE_INVALID` for a key outside `1..7`.
 */
export function normalizeAttributes(a?: TxAttributes): TxAttributes {
  const kept: RawEntry[] = [];
  for (const [type, value] of rawEntries(a)) {
    if (value !== specOf(type).nil) kept.push([type, value]);
  }
  kept.sort((x, y) => x[0] - y[0]);
  const out: Partial<Record<AttributeType, number>> = {};
  for (const [type, value] of kept) out[type as AttributeType] = value;
  return out;
}

/**
 * Apply every attribute rule, in the exact order `spec/04-tx-types.md` §6.2 specifies.
 *
 * This runs **first** in every transaction's `Validate`, so the ordering is observable: a map that
 * is both oversized and contains an unknown type reports `TOO_MANY_ATTRIBUTES`, matching the
 * reference.
 *
 * 1. absent or empty -> OK
 * 2. more than four entries -> `TOO_MANY_ATTRIBUTES`
 * 3. per entry: unknown type -> `ATTRIBUTE_TYPE_INVALID`; then value outside `[min, max]` -> the
 *    registry's per-type range code
 * 4. fees without an integrator index -> `INTEGRATOR_REQUIRED_FOR_FEES`
 * 5. a self-trade specification alongside fees -> `SELF_TRADE_SPEC_WITH_FEES`
 * 6. behaviour mode `3` alongside equality mode `1` -> `SELF_TRADE_REDUCE_WITH_MAI`
 *
 * The last check reads the **raw** map, where a missing key counts as `0`, so it only fires when
 * both keys are explicitly present with those values. The others read the *nil-ness* of each type,
 * which for type 5 is not the same question as "is it zero".
 *
 * The per-market cancel-all rule — type 5 is only legal with `ImmediateCancelAll` — is *not* here.
 * It is a `L2CancelAllOrders` rule (§7.10) and lives in that transaction's validator.
 *
 * A non-integral or unsafe `number` is rejected with `UNSAFE_INTEGER` rather than smuggled into a
 * hash: the reference cannot express one, and truncating it would silently change the transaction.
 *
 * @throws {LighterValidationError} with the code named above.
 */
export function validateAttributes(a?: TxAttributes): void {
  const entries: RawEntry[] = rawEntries(a);
  if (entries.length === 0) return;

  if (entries.length > NB_ATTRIBUTES_PER_TX) {
    throw new LighterValidationError(
      "TOO_MANY_ATTRIBUTES",
      `Too many attributes, should not be larger than ${String(NB_ATTRIBUTES_PER_TX)}`,
      { field: "Attributes" },
    );
  }

  for (const [type, value] of entries) {
    const spec: AttributeSpec = specOf(type);
    if (!Number.isSafeInteger(value)) {
      throw new LighterValidationError(
        "UNSAFE_INTEGER",
        `${spec.name} must be a safe integer, got ${String(value)}`,
        { field: spec.name },
      );
    }
    if (value < spec.min || value > spec.max) {
      throw new LighterValidationError(
        spec.rangeErrorCode,
        RANGE_MESSAGES[spec.rangeErrorCode] ?? `${spec.name} is in invalid range`,
        { field: spec.name, bound: value < spec.min ? spec.min : spec.max },
      );
    }
  }

  // `raw[t]` with a missing key reading as 0, and `isNil[t]` which for type 5 is "=== 255".
  const raw: Map<number, number> = new Map(entries.map(([type, value]) => [type, value]));
  const isNil = (type: AttributeType): boolean =>
    (raw.get(type) ?? ATTRIBUTE_REGISTRY[type].nil) === ATTRIBUTE_REGISTRY[type].nil;

  const hasFees: boolean = !isNil(2) || !isNil(3);
  if (hasFees && isNil(1)) {
    throw new LighterValidationError(
      "INTEGRATOR_REQUIRED_FOR_FEES",
      "IntegratorAccountIndex should be non-zero when integrator taker fee or maker fee is non-zero",
      { field: "IntegratorAccountIndex" },
    );
  }

  const hasSelfTradeSpec: boolean = !isNil(6) || !isNil(7);
  if (hasSelfTradeSpec && hasFees) {
    throw new LighterValidationError(
      "SELF_TRADE_SPEC_WITH_FEES",
      "Self-trade specification isn't allowed with integrator fees",
      { field: "SelfTradeBehaviorMode" },
    );
  }

  if (raw.get(7) === EQUALITY_MODE_MAI && raw.get(6) === BEHAVIOR_MODE_REDUCE) {
    throw new LighterValidationError(
      "SELF_TRADE_REDUCE_WITH_MAI",
      "Reduce self-trade behavior mode isn't allowed with master account index equality mode",
      { field: "SelfTradeBehaviorMode" },
    );
  }
}

/**
 * True when every present entry equals its registry nil value — including when there are none.
 *
 * This is a value predicate, not a size predicate: `attributesAreEmpty({6: 0})` is `true` and
 * `attributesAreEmpty({5: 0})` is `false`, because type 5's nil is `255`. It is what decides
 * whether {@link aggregateTxHash} re-hashes.
 *
 * @throws {LighterValidationError} `ATTRIBUTE_TYPE_INVALID` for a key outside `1..7`.
 */
export function attributesAreEmpty(a?: TxAttributes): boolean {
  for (const [type, value] of rawEntries(a)) {
    if (value !== specOf(type).nil) return false;
  }
  return true;
}

/**
 * The normalised 4-slot type vector: non-nil types in ascending order, zero-padded on the right.
 *
 * `spec/04-tx-types.md` §6.4. The sort covers only the populated prefix — trailing zeros stay at
 * the end, which matters because the padding slots are absorbed too.
 *
 * @throws {LighterValidationError} `ATTRIBUTE_TYPE_INVALID` for a key outside `1..7`;
 * `TOO_MANY_ATTRIBUTES` if more than four entries survive normalisation.
 */
export function attributeTypeSlots(a?: TxAttributes): readonly [number, number, number, number] {
  const populated: number[] = [];
  for (const [type, value] of rawEntries(a)) {
    if (value !== specOf(type).nil) populated.push(type);
  }
  if (populated.length > NB_ATTRIBUTES_PER_TX) {
    throw new LighterValidationError(
      "TOO_MANY_ATTRIBUTES",
      `Too many attributes, should not be larger than ${String(NB_ATTRIBUTES_PER_TX)}`,
      { field: "Attributes" },
    );
  }
  populated.sort((x, y) => x - y);
  const slots: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < populated.length; i += 1) slots[i] = populated[i] ?? 0;
  return slots;
}

/**
 * Hash the attribute set to a `GF(p^5)` element.
 *
 * The absorb list is **always exactly 8 elements** — `[type, value]` for each of the four slots,
 * with `value = 0` wherever `type === 0`. That is one full sponge block. Omitting the padding pairs
 * changes the hash of every attributed transaction, and the resulting signature is rejected by the
 * sequencer with no local test failing.
 *
 * There is no short-circuit for the empty set: `attributesHash({})` is a genuine hash of eight
 * zeros, and the first row of `tx.json` -> `attributeHashes` pins its value. The empty case is
 * handled by {@link aggregateTxHash}, not here.
 *
 * @throws {LighterValidationError} as {@link attributeTypeSlots}.
 */
export function attributesHash(a?: TxAttributes): Fp5 {
  const slots: readonly [number, number, number, number] = attributeTypeSlots(a);
  const values: Map<number, number> = new Map(rawEntries(a));
  const absorb: Fp[] = [];
  for (const type of slots) {
    absorb.push(toField(type));
    absorb.push(toField(type === 0 ? 0 : (values.get(type) ?? 0)));
  }
  return hashToQuinticExtension(absorb);
}

/**
 * The trailing step of **every** transaction hash: fold the attribute set into the transaction hash
 * and serialise to the 40 little-endian bytes that get signed.
 *
 * ```
 * empty:      fp5ToBytes(txHash)                                      // no re-hash
 * otherwise:  fp5ToBytes(hashToQuinticExtension([...txHash, ...attributesHash(a)]))
 * ```
 *
 * Both halves of that are load-bearing. Re-hashing the empty case breaks all 20 transaction types
 * at once. The non-empty input is 10 elements with the **transaction hash first**, i.e. two sponge
 * blocks of 8 and 2 with no padding — swapping the halves, or padding the short block, produces a
 * well-formed but wrong signature.
 *
 * @throws {LighterValidationError} as {@link attributeTypeSlots}.
 */
export function aggregateTxHash(txHash: Fp5, a?: TxAttributes): Uint8Array {
  if (attributesAreEmpty(a)) return fp5ToBytes(txHash);
  return fp5ToBytes(hashToQuinticExtension([...txHash, ...attributesHash(a)]));
}

/**
 * Render the attribute set as it appears in `tx_info`.
 *
 * `"null"` for an absent set, and equally for one that is empty after nil-dropping — per
 * §6.7 the reference only materialises the map when at least one non-nil option is set. Otherwise
 * an object with decimal-string keys in ascending numeric order and unquoted integer values:
 * `{"1":42,"4":1}`.
 *
 * Hand-rolled rather than `JSON.stringify`, for two reasons that both bite: `JSON.stringify` orders
 * integer-like keys ascending only by accident of the property-order specification, and the
 * transaction serialiser is schema-ordered and hand-written anyway (`src/util/json.ts` explains why
 * the sorted-key stringifier must never touch the signing path). Values are safe integers below
 * `2^48`, so `String(value)` never yields exponent notation and never yields a `bigint` suffix.
 *
 * This is the single implementation; `src/tx/serialize.ts` calls it rather than repeating it, so
 * the JSON on the wire and the bytes that were hashed cannot drift apart.
 *
 * @throws {LighterValidationError} `ATTRIBUTE_TYPE_INVALID` for a key outside `1..7`.
 */
export function attributesToJson(a?: TxAttributes): string {
  const normalized: TxAttributes = normalizeAttributes(a);
  const types: number[] = rawEntries(normalized)
    .map(([type]) => type)
    .sort((x, y) => x - y);
  if (types.length === 0) return "null";
  const values: Map<number, number> = new Map(rawEntries(normalized));
  const parts: string[] = types.map(
    (type) => `"${String(type)}":${String(values.get(type) ?? 0)}`,
  );
  return `{${parts.join(",")}}`;
}
