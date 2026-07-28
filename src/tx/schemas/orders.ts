/**
 * The five order-family schema tables: create (14), cancel (15), cancel-all (16), modify (17) and
 * grouped orders (28).
 *
 * A table is the entire definition of a transaction type here. `txHashElements` walks `hashOrder`
 * to build the signed message; `serializeTx` walks `fields` to build `tx_info`. Neither knows
 * anything about orders, and neither has a branch per transaction type. `spec/04-tx-types.md`
 * §7.8–§7.12 is the source for both lists; the counts below are from those sections and are pinned
 * by the fifteen non-grouped and three grouped rows of `conformance/vectors/tx.json`.
 *
 * | Code | Elements | Shape |
 * | --- | --- | --- |
 * | 14 `L2CreateOrder` | 16 | prefix + account, api key + the ten `OrderInfo` fields |
 * | 15 `L2CancelOrder` | 8 | prefix + account, api key, market, index |
 * | 16 `L2CancelAllOrders` | 8 | prefix + account, api key, time-in-force, time |
 * | 17 `L2ModifyOrder` | 11 | prefix + account, api key, market, index, base amount, price, trigger |
 * | 28 `L2CreateGroupedOrders` | 11 | prefix + account, api key, grouping type, 4 folded elements |
 *
 * The universal prefix `chainId, txType, Nonce, ExpiredAt` is emitted by the hasher and is
 * deliberately **not** in `hashOrder`, while `Nonce` and `ExpiredAt` *are* in `fields` because they
 * are JSON keys — in a different position. `Sig` appears only in `fields`: it cannot be inside the
 * hash it signs. `L2TxAttributes` is appended by the serialiser and is never a declared field.
 *
 * ## What is easy to get wrong here
 *
 * - **Code 14 is exactly 16 elements**, two full sponge blocks. Fifteen or seventeen means a field
 *   is missing or duplicated; recount against §7.8 rather than adjusting anything downstream.
 * - **Code 17 has no `IsAsk`, no `TimeInForce` and no `OrderExpiry`.** It is eleven elements:
 *   market, index, base amount, price, trigger price. Adding the missing three "for symmetry" gives
 *   a wrong hash for every modification.
 * - **No order field is split into two elements.** `BaseAmount` reaches `2^48 - 1` and `OrderExpiry`
 *   is a millisecond timestamp, and both are absorbed whole; the lo/hi split is hard-coded at four
 *   sites and every one of them is in the account family (`docs/protocol-notes.md` §3.2).
 * - **`MarketIndex` is `int16`.** `-1` sign-extends to `4294967294`, not `p - 1`, and so does a
 *   negative `AccountIndex` — pinned by `cancel_all_orders/negative_account_index`. That rule lives
 *   in `toField`; the schema only has to declare `{k:'int'}` and not reach for a signed variant.
 * - **`L2CreateOrder`'s JSON flattens the order fields into the parent object** (Go embedded-struct
 *   promotion), so its `fields` list interleaves them between `ApiKeyIndex` and `ExpiredAt` rather
 *   than nesting an object. The `Type` wire key is fed from the `orderType` property — see
 *   `src/tx/types/orders.ts` for why the property is renamed and the wire key is not.
 *
 * Validation is not here. `src/tx/validate/orders.ts` and `src/tx/validate/grouped.ts` own it, and
 * a schema deliberately cannot express a bound: a table that both described the wire format and
 * enforced domain rules would make the sentinel cases (`ApiKeyIndex = 255` on code 16 alone,
 * `BaseAmount = 0` on a reduce-only order) invisible.
 */

import { LighterValidationError } from "../../errors.js";
import type { Fp } from "../../crypto/field/fp.js";
import { SIGNATURE_LENGTH } from "../constants.js";
import { TxType } from "../enums.js";
import { groupedOrderElements, ordersToJson } from "../grouped-hash.js";
import {
  type Enc,
  type TxSchema,
  type TxSchemaRegistry,
  createTxSchemaRegistry,
  defineTxSchema,
} from "../schema.js";
import type { OrderInfo } from "../types/orders.js";

/** One field element, `toField`. Every order field uses it — nothing here splits. */
const INT: Enc = { k: "int" };

/** The 80-byte Schnorr signature: JSON only, base64, never hashed. */
const SIG: Enc = { k: "bytesB64", len: SIGNATURE_LENGTH };

/**
 * Narrow the schema engine's `unknown` back to the leg array.
 *
 * `{k:'custom'}` hands the raw property value to both projections, so this is the one place the
 * grouped-orders type assumption is made. It is a shape check, not a domain check — `grouped-hash`
 * re-validates each leg and rejects an empty group.
 */
function asOrders(value: unknown): readonly OrderInfo[] {
  if (!Array.isArray(value)) {
    throw new LighterValidationError(
      "FIELD_TYPE_INVALID",
      `field "orders": expected an array of OrderInfo, got ${typeof value}`,
      { field: "Orders" },
    );
  }
  return value as readonly OrderInfo[];
}

/**
 * `Orders` — four elements into the hash, an array of objects into the JSON.
 *
 * `spec/04-tx-types.md` §13.3 sketches this as its own `{k:'orders'}` encoding. It ships as
 * `{k:'custom'}` instead so that `src/tx/schema.ts` does not have to import `grouped-hash.ts`,
 * which imports it (`src/tx/schema.ts`, header). The behaviour is identical.
 */
const ORDERS: Enc = {
  k: "custom",
  elements(value: unknown): readonly Fp[] {
    return groupedOrderElements(asOrders(value));
  },
  json(value: unknown): string {
    return ordersToJson(asOrders(value));
  },
};

/**
 * `L2CreateOrder` — code 14. `spec/04-tx-types.md` §7.8.
 *
 * Sixteen absorbed elements: the four-element prefix plus the twelve in `hashOrder`. JSON promotes
 * the ten `OrderInfo` fields into the parent object, so `fields` lists them inline.
 */
export const CREATE_ORDER_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2CreateOrder,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "marketIndex", json: "MarketIndex", enc: INT },
    { name: "clientOrderIndex", json: "ClientOrderIndex", enc: INT },
    { name: "baseAmount", json: "BaseAmount", enc: INT },
    { name: "price", json: "Price", enc: INT },
    { name: "isAsk", json: "IsAsk", enc: INT },
    // The order type. Property `orderType`, wire key `Type` — the transaction's own `type`
    // discriminant carries the value 14 and never reaches the JSON.
    { name: "orderType", json: "Type", enc: INT },
    { name: "timeInForce", json: "TimeInForce", enc: INT },
    { name: "reduceOnly", json: "ReduceOnly", enc: INT },
    { name: "triggerPrice", json: "TriggerPrice", enc: INT },
    { name: "orderExpiry", json: "OrderExpiry", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: [
    "accountIndex",
    "apiKeyIndex",
    // The ten below are byte-for-byte the leaf element order of a grouped-order leg
    // (`src/tx/grouped-hash.ts`), which is why one transposition here shows up in two places.
    "marketIndex",
    "clientOrderIndex",
    "baseAmount",
    "price",
    "isAsk",
    "orderType",
    "timeInForce",
    "reduceOnly",
    "triggerPrice",
    "orderExpiry",
  ],
});

/**
 * `L2CancelOrder` — code 15. `spec/04-tx-types.md` §7.9.
 *
 * Eight elements. `Index` is a client order index or an order index, disambiguated by magnitude;
 * the schema does not care which, it is one `int64` element either way.
 */
export const CANCEL_ORDER_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2CancelOrder,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "marketIndex", json: "MarketIndex", enc: INT },
    { name: "index", json: "Index", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: ["accountIndex", "apiKeyIndex", "marketIndex", "index"],
});

/**
 * `L2CancelAllOrders` — code 16. `spec/04-tx-types.md` §7.10.
 *
 * Eight elements. This is the only type that accepts `ApiKeyIndex = 255` (`NilApiKeyIndex`, "across
 * all API keys"), and it is absorbed like any other value — the sentinel is a validation rule, not
 * an encoding one. Per-market cancel-all rides on attribute type 5, not on a struct field, so there
 * is no market index here at all.
 */
export const CANCEL_ALL_ORDERS_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2CancelAllOrders,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "timeInForce", json: "TimeInForce", enc: INT },
    { name: "time", json: "Time", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: ["accountIndex", "apiKeyIndex", "timeInForce", "time"],
});

/**
 * `L2ModifyOrder` — code 17. `spec/04-tx-types.md` §7.11.
 *
 * Eleven elements, and the absences are the interesting part: no `IsAsk`, no `TimeInForce`, no
 * `OrderExpiry`. A modification changes size, price and trigger; it cannot flip a side or extend an
 * expiry.
 */
export const MODIFY_ORDER_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2ModifyOrder,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "marketIndex", json: "MarketIndex", enc: INT },
    { name: "index", json: "Index", enc: INT },
    { name: "baseAmount", json: "BaseAmount", enc: INT },
    { name: "price", json: "Price", enc: INT },
    { name: "triggerPrice", json: "TriggerPrice", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: [
    "accountIndex",
    "apiKeyIndex",
    "marketIndex",
    "index",
    "baseAmount",
    "price",
    "triggerPrice",
  ],
});

/**
 * `L2CreateGroupedOrders` — code 28. `spec/04-tx-types.md` §7.12.
 *
 * Eleven elements: prefix, account index, api-key index, grouping type, and the four elements of
 * the aggregated leg hash. The legs themselves are never absorbed directly — only their fold is.
 */
export const CREATE_GROUPED_ORDERS_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2CreateGroupedOrders,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "groupingType", json: "GroupingType", enc: INT },
    { name: "orders", json: "Orders", enc: ORDERS },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: ["accountIndex", "apiKeyIndex", "groupingType", "orders"],
});

/**
 * The five tables, in code order.
 *
 * Exported as a list as well as a registry so the `./tx` barrel can concatenate it with the other
 * schema modules' lists and build one registry, rather than merging maps.
 */
export const ORDER_SCHEMAS: readonly TxSchema[] = Object.freeze([
  CREATE_ORDER_SCHEMA,
  CANCEL_ORDER_SCHEMA,
  CANCEL_ALL_ORDERS_SCHEMA,
  MODIFY_ORDER_SCHEMA,
  CREATE_GROUPED_ORDERS_SCHEMA,
]);

/**
 * `txType -> schema` for the order family. Look a type up with `requireTxSchema`, which fails
 * loudly on a code this SDK cannot construct.
 */
export const ORDER_SCHEMA_REGISTRY: TxSchemaRegistry = createTxSchemaRegistry(ORDER_SCHEMAS);
