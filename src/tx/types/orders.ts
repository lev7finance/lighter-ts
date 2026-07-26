/**
 * The five order-family transaction shapes, plus the `OrderInfo` payload two of them carry.
 *
 * These are the transactions a trading bot sends thousands of times a day. Everything here is a
 * plain immutable record of branded integers — no methods, no hashing, no validation. The schema
 * tables in `./../schemas/orders.ts` say how each one is absorbed and emitted; the validators in
 * `src/tx/validate/orders.ts` and `src/tx/validate/grouped.ts` say which values are legal.
 *
 * ## The discriminant is `type`, and it is the wire `tx_type`
 *
 * `spec/04-tx-types.md` §13.2: every member of the transaction union carries a numeric `type` whose
 * value is its `TxType` code, so `tx.type` is simultaneously the discriminant TypeScript narrows on,
 * the `tx_type` field of the submission envelope, and the second element of the transaction hash.
 * There is no string ↔ number mapping table anywhere in this package.
 *
 * ## Why `L2CreateOrder` says `orderType` where `OrderInfo` says `type`
 *
 * `OrderInfo.type` is the *order* type — limit, market, stop-loss, take-profit (`enums.ts` →
 * `OrderType`). `CreateOrderTx.type` is the *transaction* type, `14`. Go can hold both at once
 * because `L2CreateOrder` embeds `OrderInfo` and its own type code lives outside the struct; here
 * they would be one property with two meanings, so the flattened copy is named {@link
 * CreateOrderTx.orderType} and the wire key stays `Type` (`FieldSpec.json` is never derived from
 * `FieldSpec.name`, precisely so a rename like this costs nothing on the wire).
 *
 * The fields are flattened rather than nested because the schema engine resolves a `FieldSpec` by a
 * **flat** property lookup (`readTxField`), and because §7.8's JSON promotes them into the parent
 * object anyway (Go embedded-struct promotion). {@link orderInfoOf} recovers the `OrderInfo` view
 * for the validators, which share their per-order rules with grouped orders.
 *
 * `L2CreateGroupedOrders` keeps its legs nested — `Orders` is a genuine JSON array there, one
 * schema field, and leg order is load-bearing.
 */

import type { TxAttributes } from "../attributes.js";
import type { I16, I64, U32, U8 } from "../brands.js";
import type { TxType } from "../enums.js";

/**
 * The order payload shared by `L2CreateOrder` (flattened) and `L2CreateGroupedOrders` (as array
 * elements). `spec/04-tx-types.md` §7.7.
 *
 * Field order in this declaration is the protocol's own — it is both the JSON key order and, for
 * grouped orders, the leaf-hash absorption order (`src/tx/grouped-hash.ts`). Do not reorder it for
 * readability.
 *
 * `baseAmount` and `orderExpiry` are `bigint` because they are declared `int64`: `baseAmount`
 * reaches `2^48 - 1` and `orderExpiry` is a millisecond Unix timestamp. Neither is split into two
 * hash elements — the lo/hi split is per-field and no order field is one of the four
 * (`docs/protocol-notes.md` §3.2).
 */
export interface OrderInfo {
  /** Perps `[0, 254]` or spot `[2048, 4094]`. Signed: `int16`, and `-1` sign-extends to `4294967294`. */
  readonly marketIndex: I16;
  /** Caller-chosen id. `0` is nil; otherwise `[1, 2^48 - 1]`. */
  readonly clientOrderIndex: I64;
  /** Size in base units. `0` is nil (legal only for a reduce-only order); otherwise `[1, 2^48 - 1]`. */
  readonly baseAmount: I64;
  /** Limit price in price ticks, `[1, 2^32 - 1]`. */
  readonly price: U32;
  /** `0` bid/buy, `1` ask/sell. */
  readonly isAsk: U8;
  /** The order type — `OrderType` in `enums.ts`, `[0, 6]` for API orders. */
  readonly type: U8;
  /** `0` IOC, `1` GoodTillTime, `2` PostOnly. */
  readonly timeInForce: U8;
  /** `0` or `1`; must be `0` on spot markets. */
  readonly reduceOnly: U8;
  /** Trigger for stop-loss / take-profit variants. `0` is nil. */
  readonly triggerPrice: U32;
  /** Unix ms. `0` is nil. Never the `-1` shim sentinel — that is an FFI convention, not protocol. */
  readonly orderExpiry: I64;
}

/**
 * What every L2 transaction carries regardless of type.
 *
 * `sig` is absent until the signing stage attaches it, and `attributes` is absent when the
 * transaction has no side-channel entries — but neither is ever `undefined`-valued, because
 * `exactOptionalPropertyTypes` is on and the serialiser treats an explicitly-`undefined` declared
 * field as a construction bug.
 */
interface CommonTxFields {
  /** `[-1, 2^48 - 2]`. `-1` is `MinAccountIndex`, a legal value, not an absence marker. */
  readonly accountIndex: I64;
  /** `[0, 254]`, or `255` (`NilApiKeyIndex`) for `L2CancelAllOrders` and nothing else. */
  readonly apiKeyIndex: U8;
  /** Per-(account, api key) sequence number. Element 2 of every transaction hash. */
  readonly nonce: I64;
  /** Unix ms deadline, `[0, 2^48 - 1]`. Element 3 of every transaction hash. */
  readonly expiredAt: I64;
  /** The optional attribute side-channel. Absent and empty hash identically; see `attributes.ts`. */
  readonly attributes?: TxAttributes;
  /** The 80-byte Schnorr signature. JSON-only — it can never be inside the hash it signs. */
  readonly sig?: Uint8Array;
}

/**
 * `L2CreateOrder` — code 14. `spec/04-tx-types.md` §7.8.
 *
 * Sixteen hash elements, exactly two full sponge blocks. The `OrderInfo` fields are flattened here
 * and in the JSON; {@link orderInfoOf} gives the nested view back.
 */
export interface CreateOrderTx extends CommonTxFields, Omit<OrderInfo, "type"> {
  readonly type: typeof TxType.L2CreateOrder;
  /** `OrderInfo.type` under a non-colliding name. Wire key stays `Type`. */
  readonly orderType: U8;
}

/**
 * `L2CancelOrder` — code 15. `spec/04-tx-types.md` §7.9.
 *
 * Eight hash elements.
 */
export interface CancelOrderTx extends CommonTxFields {
  readonly type: typeof TxType.L2CancelOrder;
  readonly marketIndex: I16;
  /**
   * Either a client order index (`[1, 2^48 - 1]`) or an order index (`[2^48, 2^60 - 1]`),
   * disambiguated by magnitude. `bigint` because `MaxOrderIndex` is `2^60 - 1`.
   */
  readonly index: I64;
}

/**
 * `L2CancelAllOrders` — code 16. `spec/04-tx-types.md` §7.10.
 *
 * Eight hash elements. The only type on which `apiKeyIndex = 255` is legal — it means "across all
 * API keys" — and it is absorbed like any other value. Per-market cancel-all is expressed through
 * attribute type 5, not a struct field.
 */
export interface CancelAllOrdersTx extends CommonTxFields {
  readonly type: typeof TxType.L2CancelAllOrders;
  /** `0` Immediate, `1` Scheduled, `2` AbortScheduled — `CancelAllTimeInForce` in `enums.ts`. */
  readonly timeInForce: U8;
  /** Scheduled deadline in Unix ms; `0` unless `timeInForce` is Scheduled. */
  readonly time: I64;
}

/**
 * `L2ModifyOrder` — code 17. `spec/04-tx-types.md` §7.11.
 *
 * Eleven hash elements. Note what is *absent*: no `IsAsk`, no `TimeInForce`, no `OrderExpiry`.
 */
export interface ModifyOrderTx extends CommonTxFields {
  readonly type: typeof TxType.L2ModifyOrder;
  readonly marketIndex: I16;
  /** Client order index or order index, as `L2CancelOrder`. */
  readonly index: I64;
  /** New size. `0` leaves it unchanged. */
  readonly baseAmount: I64;
  /** New price, `[1, 2^32 - 1]`. */
  readonly price: U32;
  /** New trigger price. `0` is nil. */
  readonly triggerPrice: U32;
}

/**
 * `L2CreateGroupedOrders` — code 28. `spec/04-tx-types.md` §7.12, §8.
 *
 * Eleven hash elements: the prefix, account and api-key indices, the grouping type, and the four
 * elements of the aggregated leg hash (`src/tx/grouped-hash.ts`).
 *
 * **Leg order is load-bearing.** The fold is a left fold seeded with leg 0, so builders must not
 * sort, de-duplicate or otherwise normalise this array.
 */
export interface CreateGroupedOrdersTx extends CommonTxFields {
  readonly type: typeof TxType.L2CreateGroupedOrders;
  /** `1` OTO, `2` OCO, `3` OTOCO — `GroupingType` in `enums.ts`. `0` is rejected. */
  readonly groupingType: U8;
  /** Structurally `[1, 3]` legs; grouping validation narrows it to `{2, 3}`. */
  readonly orders: readonly OrderInfo[];
}

/** The order-family members of the transaction union. */
export type OrderTx =
  | CreateOrderTx
  | CancelOrderTx
  | CancelAllOrdersTx
  | ModifyOrderTx
  | CreateGroupedOrdersTx;

/**
 * The nested `OrderInfo` view of a flattened {@link CreateOrderTx}.
 *
 * Exists so the per-order validation rules — which grouped orders share — can be written once
 * against `OrderInfo` and applied to both. Pure; it copies ten properties and nothing else.
 */
export function orderInfoOf(tx: CreateOrderTx): OrderInfo {
  return {
    marketIndex: tx.marketIndex,
    clientOrderIndex: tx.clientOrderIndex,
    baseAmount: tx.baseAmount,
    price: tx.price,
    isAsk: tx.isAsk,
    type: tx.orderType,
    timeInForce: tx.timeInForce,
    reduceOnly: tx.reduceOnly,
    triggerPrice: tx.triggerPrice,
    orderExpiry: tx.orderExpiry,
  };
}
