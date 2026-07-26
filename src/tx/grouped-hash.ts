/**
 * The one piece of order hashing the generic schema engine cannot express: folding several order
 * legs into the four field elements `L2CreateGroupedOrders` absorbs.
 *
 * ## The fold, and the dead accumulator
 *
 * `docs/protocol-notes.md` §4 and `spec/04-tx-types.md` §7.12:
 *
 * ```text
 * leaf(o) = hashNoPad([ marketIndex, clientOrderIndex, baseAmount, price, isAsk,
 *                       type, timeInForce, reduceOnly, triggerPrice, orderExpiry ])
 * acc = leaf(orders[0])                                   // ASSIGNED, not folded into
 * for i in 1..n-1:  acc = hashTwoToOne(acc, leaf(orders[i]))
 * ```
 *
 * The reference initialises its accumulator to the empty hash and then never uses that value:
 * index 0 assigns the leg hash directly. Seeding the fold with `EMPTY_HASH_OUT` and folding leg 0
 * into it is the obvious reading of the code and produces a different, entirely plausible-looking
 * digest for **every** group — a wrong hash for every grouped order ever sent, with nothing to
 * point at. `hashNToOne` in `src/crypto/poseidon2/index.ts` already implements the correct shape,
 * so this module composes it rather than re-deriving the loop; the regression test that pins the
 * distinction lives in `test/tx/grouped-hash.test.ts`.
 *
 * ## Three further ways to get this wrong
 *
 * - **The leaf is `hashNoPad` (4 outputs), not `hashToQuinticExtension` (5).** The aggregate is a
 *   `HashOut` and contributes exactly four elements to the parent transaction hash.
 * - **Ten leaf elements is two sponge blocks (8 + 2) with no padding**, and the rate lanes are not
 *   zeroed between them. The leaf hash is only correct if the sponge is.
 * - **`baseAmount` and `orderExpiry` are single elements** even though both exceed 32 bits. The
 *   lo/hi split is hard-coded at four sites and none of them is an order field
 *   (`docs/protocol-notes.md` §3.2); splitting by magnitude passes every small-value test and
 *   corrupts every large order.
 *
 * A single-leg group is structurally legal (`Orders.length` is checked against `[1, 3]` before
 * grouping validation narrows it), so {@link aggregateOrderHash} of one leg is that leg's hash,
 * unfolded. An empty array throws rather than returning the empty hash: `EMPTY_HASH_OUT` is a real
 * digest value here, not a sentinel, and returning it would hash a group with no orders to
 * something a validator could plausibly accept.
 *
 * ## Ownership
 *
 * The dependency arrow points from `src/tx/schemas/orders.ts` to here, through the engine's
 * `{k:'custom'}` encoding. That is why `Enc` has no `{k:'orders'}` variant — it would make the
 * vocabulary module import this one, which imports it (`src/tx/schema.ts`, header).
 */

import { LighterValidationError } from "../errors.js";
import type { Fp } from "../crypto/field/fp.js";
import { type HashOut, hashNToOne, hashNoPad } from "../crypto/poseidon2/index.js";
import { toField } from "./field-encode.js";
import type { OrderInfo } from "./types/orders.js";

/**
 * The ten `OrderInfo` fields, in protocol order, paired with their wire keys.
 *
 * One table drives both projections because `spec/04-tx-types.md` §7.7 gives them the same order:
 * the leaf-hash absorption order *is* the JSON key order, and it is identical to the order-specific
 * tail of `L2CreateOrder`'s sixteen elements (§7.8). Keeping them in one list means a field cannot
 * be added to the hash and forgotten in the JSON, or vice versa.
 */
const ORDER_INFO_FIELDS: readonly { readonly key: keyof OrderInfo; readonly json: string }[] =
  Object.freeze([
    { key: "marketIndex", json: "MarketIndex" },
    { key: "clientOrderIndex", json: "ClientOrderIndex" },
    { key: "baseAmount", json: "BaseAmount" },
    { key: "price", json: "Price" },
    { key: "isAsk", json: "IsAsk" },
    { key: "type", json: "Type" },
    { key: "timeInForce", json: "TimeInForce" },
    { key: "reduceOnly", json: "ReduceOnly" },
    { key: "triggerPrice", json: "TriggerPrice" },
    { key: "orderExpiry", json: "OrderExpiry" },
  ] as const);

/** How many elements one leg contributes. Named so a miscount is a failing assertion, not a hash. */
export const ORDER_LEAF_ELEMENT_COUNT: 10 = 10;

/**
 * Narrow one leg, naming its position.
 *
 * The static type says `OrderInfo`, but a transaction reaches here through the schema engine's
 * `unknown`-typed `{k:'custom'}` seam, so a hole in the array or a leg that is not an object has to
 * fail loudly rather than hash `undefined` fields into plausible zeros.
 */
function orderAt(orders: readonly OrderInfo[], index: number): OrderInfo {
  const order: unknown = orders[index];
  if (order === null || typeof order !== "object") {
    throw new LighterValidationError(
      "FIELD_TYPE_INVALID",
      `Orders[${String(index)}]: expected an OrderInfo object, got ${typeof order}`,
      { field: "Orders" },
    );
  }
  return order as OrderInfo;
}

/** Reject anything that is not an array, before indexing into it. */
function assertOrderArray(orders: readonly OrderInfo[]): void {
  if (!Array.isArray(orders)) {
    throw new LighterValidationError(
      "FIELD_TYPE_INVALID",
      `Orders: expected an array of OrderInfo, got ${typeof (orders as unknown)}`,
      { field: "Orders" },
    );
  }
}

/**
 * The ten elements of one leg, with `label` naming it in any error (`"Orders[2]"`, `"OrderInfo"`).
 *
 * @throws {LighterValidationError} `FIELD_TYPE_INVALID` for a non-integer field, or the range codes
 * `toField` raises for a value outside `[-2^63, 2^64)`.
 */
function leafElements(order: OrderInfo, label: string): Fp[] {
  const elements: Fp[] = [];
  for (const field of ORDER_INFO_FIELDS) {
    const value: unknown = order[field.key];
    if (typeof value !== "bigint" && typeof value !== "number") {
      throw new LighterValidationError(
        "FIELD_TYPE_INVALID",
        `${label}.${field.json}: expected a bigint or number, got ${typeof value}`,
        { field: field.json },
      );
    }
    elements.push(toField(value));
  }
  return elements;
}

/**
 * The ten field elements one leg contributes, in absorption order.
 *
 * Exactly the order-specific tail of `L2CreateOrder`'s hash — that identity is asserted in the
 * tests, because it is the cheapest way to catch a transposition in either list.
 */
export function orderLeafElements(order: OrderInfo): readonly Fp[] {
  return leafElements(order, "OrderInfo");
}

/**
 * One leg's digest: `hashNoPad` over its ten elements.
 *
 * Four outputs, not five. Ten inputs means two sponge blocks, `8 + 2`, with no padding element and
 * no clearing of rate lanes 2..7 between them.
 */
export function orderLeafHash(order: OrderInfo): HashOut {
  return hashNoPad(orderLeafElements(order));
}

/**
 * Fold the legs left to right, seeded with leg 0.
 *
 * `aggregateOrderHash([leg])` is `orderLeafHash(leg)` — no folding happens for a single leg, which
 * is what makes the seeded form observably different from folding out of the empty hash.
 *
 * @throws {LighterValidationError} `ORDER_GROUP_SIZE_INVALID` on an empty array. The reference
 * indexes leg 0 unconditionally and panics; returning `EMPTY_HASH_OUT` would instead produce a
 * signable transaction describing no orders.
 */
export function aggregateOrderHash(orders: readonly OrderInfo[]): HashOut {
  assertOrderArray(orders);
  if (orders.length === 0) {
    throw new LighterValidationError(
      "ORDER_GROUP_SIZE_INVALID",
      "Orders: a grouped-orders transaction needs at least one leg; the fold is seeded with leg 0",
      { field: "Orders" },
    );
  }
  const leaves: HashOut[] = [];
  for (let i: number = 0; i < orders.length; i += 1) {
    leaves.push(hashNoPad(leafElements(orderAt(orders, i), `Orders[${String(i)}]`)));
  }
  return hashNToOne(leaves);
}

/**
 * The four elements `L2CreateGroupedOrders` absorbs for its `Orders` field.
 *
 * This is the function wired into the schema's `{k:'custom'}` encoding. The `HashOut` is spread into
 * a plain element list: the four values are absorbed individually, in order, as elements 7..10 of
 * the transaction hash.
 */
export function groupedOrderElements(orders: readonly OrderInfo[]): readonly Fp[] {
  const aggregate: HashOut = aggregateOrderHash(orders);
  return [aggregate[0], aggregate[1], aggregate[2], aggregate[3]];
}

/**
 * Write an integer the way Go's `encoding/json` does: decimal digits, unquoted, never exponent
 * notation.
 *
 * A local copy of `serialize.ts`'s rule rather than an import, because that helper is private to
 * the emitter and this is the only other place in the codec that writes a number outside it. The
 * safe-integer check is what makes "never exponent notation" a guarantee rather than a coincidence:
 * `String` only reaches exponent form at `1e21`, well past `2^53`, and `bigint` never does.
 */
function integerJson(value: unknown, label: string, json: string): string {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new LighterValidationError(
        "UNSAFE_INTEGER",
        `${label}.${json}: ${String(value)} is not a safe integer; pass a bigint for values beyond 2^53 - 1`,
        { field: json },
      );
    }
    return String(value);
  }
  throw new LighterValidationError(
    "FIELD_TYPE_INVALID",
    `${label}.${json}: expected a bigint or number, got ${typeof value}`,
    { field: json },
  );
}

/**
 * The `Orders` JSON value: `[{…},{…}]`, keys in `spec/04-tx-types.md` §7.7 order.
 *
 * No key is omitted — nothing in the protocol uses `omitempty`, so a nil `TriggerPrice` is emitted
 * as `0` rather than dropped. An empty array is written as `[]` rather than rejected: the hash path
 * is where an empty group is refused, and the emitter's job is to describe what it is handed.
 */
export function ordersToJson(orders: readonly OrderInfo[]): string {
  assertOrderArray(orders);
  const objects: string[] = [];
  for (let i: number = 0; i < orders.length; i += 1) {
    const label: string = `Orders[${String(i)}]`;
    const order: OrderInfo = orderAt(orders, i);
    const parts: string[] = [];
    for (const field of ORDER_INFO_FIELDS) {
      parts.push(`"${field.json}":${integerJson(order[field.key], label, field.json)}`);
    }
    objects.push(`{${parts.join(",")}}`);
  }
  return `[${objects.join(",")}]`;
}
