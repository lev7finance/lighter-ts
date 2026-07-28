/**
 * Local validation for the four non-grouped order transactions — `L2CreateOrder` (14),
 * `L2CancelOrder` (15), `L2CancelAllOrders` (16) and `L2ModifyOrder` (17).
 *
 * The point of validating locally is that a rejection costs nothing, while a rejection by the
 * sequencer costs a round trip and burns a nonce. So this module reproduces the reference
 * validator's rules — and, just as importantly, its *order*.
 *
 * ## Check order is normative, not stylistic
 *
 * The reference returns on the first violated predicate, so the check sequence determines which
 * error a transaction that breaks two rules at once reports. An input is rarely wrong in exactly
 * one way, and a caller branching on `code` sees a different identity if the order drifts. Every
 * sequence below is `spec/04-tx-types.md` §7.8–§7.11 verbatim; the two places where it is
 * surprising are called out in comments where they happen:
 *
 * - `TriggerPrice`'s *range* check runs **after** the per-`Type` matrix, not with the other bounds.
 * - `L2CancelAllOrders` checks `Nonce` and `ExpiredAt` in the **middle**; every other transaction
 *   checks them last.
 *
 * ## Why three of the steps are exported on their own
 *
 * `src/tx/validate/grouped.ts` applies the same per-order rules to each leg of an
 * `L2CreateGroupedOrders`, but in a different order — which is only expressible if the steps are
 * separately callable. Hence {@link validateOrderCore}, {@link validateOrderTypeMatrix} and
 * {@link validateTriggerPriceRange}. Everything else here is local: there is deliberately no shared
 * `validate/common.ts`, because the reference duplicates its bound checks per transaction and a
 * shared helper would quietly impose one transaction's ordering on another.
 *
 * Those three take a plain `ctx` rather than a transaction, so they cannot stamp `txType` on the
 * errors they raise — a leg of a grouped order is not a `L2CreateOrder`. The per-transaction
 * validators stamp `txType` on the checks they own. `code` and `field` are always present.
 *
 * ## What is not here
 *
 * - **Attribute validation** (§6.2) belongs to `src/tx/attributes.ts` and runs *first* in every
 *   transaction. This module calls {@link validateAttributes}; it does not reimplement any of it.
 *   The one attribute rule that *is* here is §7.10's per-market cancel-all cross-check, because it
 *   is a rule about `L2CancelAllOrders.TimeInForce` that happens to read an attribute.
 * - **`MinOrderCancelAllPeriod` / `MaxOrderCancelAllPeriod`** are advisory sequencer-side bounds.
 *   §7.10 says the SDK does not enforce them, and enforcing them here would reject transactions
 *   the sequencer accepts.
 * - **Width checks.** `u8()`, `i16()`, `u32()` and `i64()` already proved the value fits its
 *   protocol width (`brands.ts`). These functions check *domains*.
 *
 * Sentinels that read like absences and are not: `AccountIndex = -1` is `MinAccountIndex` and is
 * legal; `ApiKeyIndex = 255` is legal for `L2CancelAllOrders` and for nothing else; `BaseAmount = 0`
 * is legal on a reduce-only order; attribute-5 value `255` means "all markets".
 */

import { LighterValidationError } from "../../errors.js";
import type { LighterValidationCode, LighterValidationErrorOptions } from "../../errors.js";
import { validateAttributes } from "../attributes.js";
import type { TxAttributes } from "../attributes.js";
import {
  MAX_ACCOUNT_INDEX,
  MAX_API_KEY_INDEX,
  MAX_CLIENT_ORDER_INDEX,
  MAX_ORDER_BASE_AMOUNT,
  MAX_ORDER_EXPIRY,
  MAX_ORDER_INDEX,
  MAX_ORDER_PRICE,
  MAX_ORDER_TRIGGER_PRICE,
  MAX_PERPS_MARKET_INDEX,
  MAX_SPOT_MARKET_INDEX,
  MAX_TIMESTAMP,
  MIN_ACCOUNT_INDEX,
  MIN_API_KEY_INDEX,
  MIN_CLIENT_ORDER_INDEX,
  MIN_NONCE,
  MIN_ORDER_BASE_AMOUNT,
  MIN_ORDER_EXPIRY,
  MIN_ORDER_PRICE,
  MIN_ORDER_TRIGGER_PRICE,
  MIN_PERPS_MARKET_INDEX,
  MIN_SPOT_MARKET_INDEX,
  NIL_API_KEY_INDEX,
  NIL_CLIENT_ORDER_INDEX,
  NIL_MARKET_INDEX,
  NIL_ORDER_BASE_AMOUNT,
  NIL_ORDER_EXPIRY,
  NIL_ORDER_TRIGGER_PRICE,
} from "../constants.js";
import { CancelAllTimeInForce, OrderTimeInForce, OrderType, TxType } from "../enums.js";
import { orderInfoOf } from "../types/orders.js";
import type {
  CancelAllOrdersTx,
  CancelOrderTx,
  CreateOrderTx,
  ModifyOrderTx,
  OrderInfo,
} from "../types/orders.js";

/* -------------------------------------------------------------------------------------------------
 * Messages — `spec/04-tx-types.md` §12, verbatim.
 *
 * They are quoted by user-facing tooling, so they match the reference sentinel's text exactly even
 * where that text is misleading. `ORDER_INDEX_TOO_LOW` is the notable one: its message names
 * `281474976710656` while the predicate it accompanies is `Index < 1`, because `L2CancelOrder`
 * reuses a sentinel written for a stricter bound. Reproduce, do not improve.
 * ---------------------------------------------------------------------------------------------- */

const MSG_ACCOUNT_INDEX_TOO_LOW: string = "AccountIndex should not be less than -1";
const MSG_ACCOUNT_INDEX_TOO_HIGH: string =
  "AccountIndex should not be larger than 281474976710654";
const MSG_API_KEY_INDEX_TOO_LOW: string = "ApiKeyIndex should not be less than 0";
const MSG_API_KEY_INDEX_TOO_HIGH: string = "ApiKeyIndex should not be larger than 254";
const MSG_NONCE_TOO_LOW: string = "AccountNonce should not be less than 0";
const MSG_EXPIRED_AT_INVALID: string = "ExpiredAt is invalid";
const MSG_MARKET_INDEX_INVALID: string = "MarketIndex is not valid";
const MSG_CLIENT_ORDER_INDEX_TOO_LOW: string = "ClientOrderIndex should not be less than 1";
const MSG_CLIENT_ORDER_INDEX_TOO_HIGH: string =
  "ClientOrderIndex should not be larger than 281474976710655";
const MSG_ORDER_INDEX_TOO_LOW: string = "OrderIndex should not be less than 281474976710656";
const MSG_ORDER_INDEX_TOO_HIGH: string =
  "OrderIndex should not be larger than 1152921504606846975";
const MSG_BASE_AMOUNT_TOO_LOW: string = "BaseAmount should not be less than 1";
const MSG_BASE_AMOUNT_TOO_HIGH: string = "BaseAmount should not be larger than 281474976710655";
const MSG_PRICE_TOO_LOW: string = "OrderPrice should not be less than 1";
const MSG_PRICE_TOO_HIGH: string = "OrderPrice should not be larger than 4294967295";
const MSG_IS_ASK_INVALID: string = "IsAsk should be 0 or 1";
const MSG_ORDER_TIF_INVALID: string = "OrderTimeInForce is not valid";
const MSG_ORDER_REDUCE_ONLY_INVALID: string = "ReduceOnly is invalid";
const MSG_ORDER_EXPIRY_INVALID: string = "OrderExpiry is invalid";
const MSG_ORDER_TRIGGER_PRICE_INVALID: string = "TriggerPrice is invalid";
const MSG_ORDER_TYPE_INVALID: string = "OrderType is not valid";
const MSG_CANCEL_ALL_TIF_INVALID: string = "CancelAllTimeInForce is invalid";
const MSG_CANCEL_ALL_TIME_NOT_NIL: string = "CancelAllTime should be nil";
const MSG_CANCEL_ALL_TIME_OUT_OF_RANGE: string =
  "CancelAllTime should be larger than 0 and not larger than 9223372036854775807";
const MSG_CANCEL_ALL_MARKET_CANT_BE_SCHEDULED: string =
  "Cancel all for market index can't be scheduled, TimeInforce must be ImmediateCancelAll";

/* -------------------------------------------------------------------------------------------------
 * Local domain values that `constants.ts` does not name on their own.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Lowest legal `Index` for `L2CancelOrder` / `L2ModifyOrder`.
 *
 * The reference writes `Index < MinClientOrderIndex && Index < MinOrderIndex`, which collapses to
 * `Index < 1` because a client order index may be as low as `1` (§7.9). Implement the collapsed
 * form — the un-collapsed one rejects every client order index below `2^48`.
 */
const MIN_ANY_ORDER_INDEX: bigint = MIN_CLIENT_ORDER_INDEX;

/** Highest legal `Index`: the reference's `Index > MaxClientOrderIndex && Index > MaxOrderIndex`. */
const MAX_ANY_ORDER_INDEX: bigint = MAX_ORDER_INDEX;

/** `Time` on a scheduled cancel-all is bounded by the same `int64` pair as an order expiry. */
const MIN_CANCEL_ALL_TIME: bigint = MIN_ORDER_EXPIRY;
const MAX_CANCEL_ALL_TIME: bigint = MAX_ORDER_EXPIRY;

/** `L2TxAttributes` type 5, `CancelAllMarketIndex` — the per-market cancel-all selector (§6.1). */
const CANCEL_ALL_MARKET_ATTRIBUTE: 5 = 5;

/** `Time` and `Nonce` nil value. */
const ZERO: bigint = 0n;

/** `IsAsk` bid side. */
const IS_ASK_BID: 0 = 0;
/** `IsAsk` ask side. */
const IS_ASK_ASK: 1 = 1;

/** `ReduceOnly` off. */
const REDUCE_ONLY_OFF: 0 = 0;
/** `ReduceOnly` on. */
const REDUCE_ONLY_ON: 1 = 1;

/* -------------------------------------------------------------------------------------------------
 * Public surface
 * ---------------------------------------------------------------------------------------------- */

/** Which market family a market index belongs to. */
export type MarketKind = "perps" | "spot";

/**
 * Classify a market index: perps `[0, 254]`, spot `[2048, 4094]`, or `null`.
 *
 * The two windows are disjoint and the gap between them is not a market. In particular `255` is
 * {@link NIL_MARKET_INDEX} and belongs to neither family, so it is `null` here and
 * `MARKET_INDEX_INVALID` in every order validator — it is a sentinel for the cancel-all *attribute*
 * ("all markets"), never a market a transaction can name.
 */
export function marketKind(marketIndex: number): MarketKind | null {
  if (marketIndex >= MIN_PERPS_MARKET_INDEX && marketIndex <= MAX_PERPS_MARKET_INDEX) {
    return "perps";
  }
  if (marketIndex >= MIN_SPOT_MARKET_INDEX && marketIndex <= MAX_SPOT_MARKET_INDEX) {
    return "spot";
  }
  return null;
}

/**
 * Options accepted by every validator in `src/tx/validate/*`.
 *
 * `strict` defaults to `true`. It gates the checks this SDK adds *beyond* the reference — the
 * `MARKET_INDEX_NOT_PERPS` / `CHILD_REDUCE_ONLY_MISMATCH` family in §12's "new codes" list. None of
 * those apply to the four transactions in this module: every rule below is one the reference
 * enforces, so turning `strict` off here changes nothing. The option exists so callers can pass one
 * object through a whole pipeline, and so `grouped.ts` — where it does gate checks — takes the same
 * shape.
 */
export interface OrderValidateOptions {
  readonly strict?: boolean;
}

/**
 * Steps 6–16 of §7.8: the per-order field bounds shared by `L2CreateOrder` and every grouped leg.
 *
 * Excludes the market-index gate (step 5), which the caller has already run to produce `ctx`, the
 * per-`Type` matrix (step 17, {@link validateOrderTypeMatrix}) and the trigger-price range
 * (step 18, {@link validateTriggerPriceRange}).
 *
 * Two rules here are routinely written wrong:
 *
 * - **`BaseAmount === 0` is legal on a reduce-only order.** The predicate is
 *   `ReduceOnly !== 1 && BaseAmount === 0`, not `BaseAmount === 0`. A position-tied stop-loss is
 *   expressed as `BaseAmount = 0, ReduceOnly = 1`; rejecting it breaks every bracket order.
 * - **`Price` has no nil sentinel.** `Price < 1` is rejected even for a market order, which sends
 *   its slippage bound as a price (vector `create_order/market_ioc_sell` carries `4294967295`).
 *
 * @throws {LighterValidationError} the §12 code of the first violated step.
 */
export function validateOrderCore(o: OrderInfo, ctx: { isSpot: boolean }): void {
  // 6-7. ClientOrderIndex: `0` is nil and skips the bounds entirely.
  if (o.clientOrderIndex !== NIL_CLIENT_ORDER_INDEX) {
    if (o.clientOrderIndex < MIN_CLIENT_ORDER_INDEX) {
      fail("CLIENT_ORDER_INDEX_TOO_LOW", MSG_CLIENT_ORDER_INDEX_TOO_LOW, {
        field: "ClientOrderIndex",
        bound: MIN_CLIENT_ORDER_INDEX,
      });
    }
    if (o.clientOrderIndex > MAX_CLIENT_ORDER_INDEX) {
      fail("CLIENT_ORDER_INDEX_TOO_HIGH", MSG_CLIENT_ORDER_INDEX_TOO_HIGH, {
        field: "ClientOrderIndex",
        bound: MAX_CLIENT_ORDER_INDEX,
      });
    }
  }

  // 8. A nil size is legal only when the order is reduce-only.
  if (o.reduceOnly !== REDUCE_ONLY_ON && o.baseAmount === NIL_ORDER_BASE_AMOUNT) {
    fail("BASE_AMOUNT_TOO_LOW", MSG_BASE_AMOUNT_TOO_LOW, {
      field: "BaseAmount",
      bound: MIN_ORDER_BASE_AMOUNT,
    });
  }
  // 9. Otherwise a non-nil size is at least 1 — this is what catches negatives.
  if (o.baseAmount !== NIL_ORDER_BASE_AMOUNT && o.baseAmount < MIN_ORDER_BASE_AMOUNT) {
    fail("BASE_AMOUNT_TOO_LOW", MSG_BASE_AMOUNT_TOO_LOW, {
      field: "BaseAmount",
      bound: MIN_ORDER_BASE_AMOUNT,
    });
  }
  // 10. Unconditional upper bound.
  if (o.baseAmount > MAX_ORDER_BASE_AMOUNT) {
    fail("BASE_AMOUNT_TOO_HIGH", MSG_BASE_AMOUNT_TOO_HIGH, {
      field: "BaseAmount",
      bound: MAX_ORDER_BASE_AMOUNT,
    });
  }

  // 11-12. Price, with no nil sentinel.
  if (o.price < MIN_ORDER_PRICE) {
    fail("PRICE_TOO_LOW", MSG_PRICE_TOO_LOW, { field: "Price", bound: MIN_ORDER_PRICE });
  }
  if (o.price > MAX_ORDER_PRICE) {
    fail("PRICE_TOO_HIGH", MSG_PRICE_TOO_HIGH, { field: "Price", bound: MAX_ORDER_PRICE });
  }

  // 13. Side.
  if (o.isAsk !== IS_ASK_BID && o.isAsk !== IS_ASK_ASK) {
    fail("IS_ASK_INVALID", MSG_IS_ASK_INVALID, { field: "IsAsk" });
  }

  // 14. Time in force, as a membership test — the per-Type matrix narrows it further.
  if (
    o.timeInForce !== OrderTimeInForce.ImmediateOrCancel &&
    o.timeInForce !== OrderTimeInForce.GoodTillTime &&
    o.timeInForce !== OrderTimeInForce.PostOnly
  ) {
    fail("ORDER_TIF_INVALID", MSG_ORDER_TIF_INVALID, { field: "TimeInForce" });
  }

  // 15. Reduce-only is a flag, and it is illegal on spot markets.
  if (
    (o.reduceOnly !== REDUCE_ONLY_OFF && o.reduceOnly !== REDUCE_ONLY_ON) ||
    (ctx.isSpot && o.reduceOnly === REDUCE_ONLY_ON)
  ) {
    fail("ORDER_REDUCE_ONLY_INVALID", MSG_ORDER_REDUCE_ONLY_INVALID, { field: "ReduceOnly" });
  }

  // 16. OrderExpiry: `0` is nil; anything else is a positive int64 millisecond timestamp.
  if (
    o.orderExpiry !== NIL_ORDER_EXPIRY &&
    (o.orderExpiry < MIN_ORDER_EXPIRY || o.orderExpiry > MAX_ORDER_EXPIRY)
  ) {
    fail("ORDER_EXPIRY_INVALID", MSG_ORDER_EXPIRY_INVALID, { field: "OrderExpiry" });
  }
}

/**
 * Step 17 of §7.8: the per-`Type` matrix, evaluated as a switch with first-clause-wins.
 *
 * | `Type` | rules |
 * | --- | --- |
 * | 1 `Market` | `TIF` is IOC; `OrderExpiry` nil; `TriggerPrice` nil |
 * | 0 `Limit` | `TriggerPrice` nil; `TIF === IOC ⇔ OrderExpiry === 0` (both directions) |
 * | 2 `StopLoss`, 4 `TakeProfit` | perps only; `TIF` is IOC; `TriggerPrice` and `OrderExpiry` set |
 * | 3 `StopLossLimit`, 5 `TakeProfitLimit` | perps only; `TriggerPrice` and `OrderExpiry` set — **no TIF constraint** |
 * | 6 `Twap` | `TIF` is GoodTillTime; `TriggerPrice` nil; `OrderExpiry` set |
 * | 7, 8, ≥9 | always invalid — engine-internal types |
 *
 * The asymmetry between rows 2/4 and 3/5 is load-bearing, not an oversight: the *limit* trigger
 * variants carry no time-in-force constraint, and vector `create_order/stop_loss_limit_reduce_only`
 * is a `Type: 3` with `TimeInForce: 1` (GoodTillTime) that must validate clean. Copying the row-2
 * IOC rule onto row 3 fails that vector.
 *
 * Note what this does *not* check: whether `TriggerPrice` is in range. That is step 18,
 * {@link validateTriggerPriceRange}, and it deliberately runs afterwards.
 *
 * @throws {LighterValidationError} `ORDER_TYPE_INVALID`, `ORDER_TIF_INVALID`,
 * `ORDER_TRIGGER_PRICE_INVALID` or `ORDER_EXPIRY_INVALID`.
 */
export function validateOrderTypeMatrix(o: OrderInfo, ctx: { isPerps: boolean }): void {
  const hasTrigger: boolean = o.triggerPrice !== NIL_ORDER_TRIGGER_PRICE;
  const hasExpiry: boolean = o.orderExpiry !== NIL_ORDER_EXPIRY;
  const isIoc: boolean = o.timeInForce === OrderTimeInForce.ImmediateOrCancel;
  // Widened out of its brand so the `case` labels stay plain numeric literals.
  const orderType: number = o.type;

  switch (orderType) {
    case OrderType.Market: {
      if (!isIoc) failTif();
      if (hasExpiry) failExpiry();
      if (hasTrigger) failTrigger();
      return;
    }

    case OrderType.Limit: {
      if (hasTrigger) failTrigger();
      // Both directions: an IOC limit order may not carry an expiry, and a GTT or post-only one
      // must. Checking only the first half accepts a GoodTillTime order that never expires.
      if (isIoc && hasExpiry) failExpiry();
      if (!isIoc && !hasExpiry) failExpiry();
      return;
    }

    case OrderType.StopLoss:
    case OrderType.TakeProfit: {
      if (!ctx.isPerps) failType();
      if (!isIoc) failTif();
      if (!hasTrigger) failTrigger();
      if (!hasExpiry) failExpiry();
      return;
    }

    case OrderType.StopLossLimit:
    case OrderType.TakeProfitLimit: {
      if (!ctx.isPerps) failType();
      // No time-in-force constraint here. See the note above before adding one.
      if (!hasTrigger) failTrigger();
      if (!hasExpiry) failExpiry();
      return;
    }

    case OrderType.Twap: {
      if (o.timeInForce !== OrderTimeInForce.GoodTillTime) failTif();
      if (hasTrigger) failTrigger();
      if (!hasExpiry) failExpiry();
      return;
    }

    // `TwapSub` (7), `Liquidation` (8) and everything above are produced by the matching engine and
    // are never client-settable.
    default:
      failType();
  }
}

/**
 * Step 18 of §7.8: `TriggerPrice !== 0 && (TriggerPrice < 1 || TriggerPrice > 2^32 - 1)`.
 *
 * Separate from {@link validateOrderTypeMatrix} because of where it sits: after the matrix for
 * `L2CreateOrder`, and elsewhere for a grouped leg. Both spellings raise
 * `ORDER_TRIGGER_PRICE_INVALID`, so the order is only observable when a *second* rule is also
 * broken — e.g. a `Type: 1` market order with a garbage trigger reports the matrix's
 * "market orders may not have a trigger" clause rather than this range clause.
 *
 * @throws {LighterValidationError} `ORDER_TRIGGER_PRICE_INVALID`.
 */
export function validateTriggerPriceRange(o: OrderInfo): void {
  if (
    o.triggerPrice !== NIL_ORDER_TRIGGER_PRICE &&
    (o.triggerPrice < MIN_ORDER_TRIGGER_PRICE || o.triggerPrice > MAX_ORDER_TRIGGER_PRICE)
  ) {
    fail("ORDER_TRIGGER_PRICE_INVALID", MSG_ORDER_TRIGGER_PRICE_INVALID, {
      field: "TriggerPrice",
    });
  }
}

/**
 * Validate an `L2CreateOrder` (type 14) — `spec/04-tx-types.md` §7.8, all twenty steps.
 *
 * ```text
 * attributes -> accountIndex -> apiKeyIndex -> market gate
 *   -> clientOrderIndex -> baseAmount -> price -> isAsk -> timeInForce -> reduceOnly -> orderExpiry
 *   -> TYPE MATRIX -> triggerPrice range -> nonce -> expiredAt
 * ```
 *
 * @throws {LighterValidationError} the §12 code of the first violated rule.
 */
export function validateCreateOrder(tx: CreateOrderTx, opts?: OrderValidateOptions): void {
  // `strict` gates no additional rule for this transaction — see {@link OrderValidateOptions}.
  void opts;
  const txType: number = TxType.L2CreateOrder;

  validateAttributes(tx.attributes);
  checkAccountIndex(tx.accountIndex, txType);
  checkApiKeyIndex(tx.apiKeyIndex, txType, false);

  const kind: MarketKind | null = checkMarketIndex(tx.marketIndex, txType);
  const order: OrderInfo = orderInfoOf(tx);

  validateOrderCore(order, { isSpot: kind === "spot" });
  validateOrderTypeMatrix(order, { isPerps: kind === "perps" });
  // Step 18 — after the matrix. Moving it earlier changes which clause reports a bad trigger.
  validateTriggerPriceRange(order);

  checkNonce(tx.nonce, txType);
  checkExpiredAt(tx.expiredAt, txType);
}

/**
 * Validate an `L2CancelOrder` (type 15) — `spec/04-tx-types.md` §7.9.
 *
 * `Index` is a client order index (`[1, 2^48 - 1]`) or an order index (`[2^48, 2^60 - 1]`),
 * disambiguated downstream by magnitude; the validator only bounds the union, `[1, 2^60 - 1]`.
 *
 * @throws {LighterValidationError} the §12 code of the first violated rule.
 */
export function validateCancelOrder(tx: CancelOrderTx, opts?: OrderValidateOptions): void {
  // `strict` gates no additional rule for this transaction — see {@link OrderValidateOptions}.
  void opts;
  const txType: number = TxType.L2CancelOrder;

  validateAttributes(tx.attributes);
  checkAccountIndex(tx.accountIndex, txType);
  checkApiKeyIndex(tx.apiKeyIndex, txType, false);
  checkMarketIndex(tx.marketIndex, txType);

  // §7.9 / ADR-13: `L2CancelOrder` reports the ORDER_INDEX_* pair for this predicate while
  // `L2ModifyOrder` reports the CLIENT_ORDER_INDEX_* pair for the identical one. That divergence is
  // copy-paste in the reference, it is observable, and it is reproduced on purpose. Do not unify.
  if (tx.index < MIN_ANY_ORDER_INDEX) {
    fail("ORDER_INDEX_TOO_LOW", MSG_ORDER_INDEX_TOO_LOW, {
      field: "Index",
      txType,
      bound: MIN_ANY_ORDER_INDEX,
    });
  }
  if (tx.index > MAX_ANY_ORDER_INDEX) {
    fail("ORDER_INDEX_TOO_HIGH", MSG_ORDER_INDEX_TOO_HIGH, {
      field: "Index",
      txType,
      bound: MAX_ANY_ORDER_INDEX,
    });
  }

  checkNonce(tx.nonce, txType);
  checkExpiredAt(tx.expiredAt, txType);
}

/**
 * Validate an `L2CancelAllOrders` (type 16) — `spec/04-tx-types.md` §7.10.
 *
 * Two things are peculiar to this transaction and both are checked here:
 *
 * - **`Nonce` and `ExpiredAt` are checked in the middle**, before the attribute cross-check and the
 *   time-in-force switch. Every other transaction checks them last, so a cancel-all that is wrong
 *   in both the nonce and the TIF reports `NONCE_TOO_LOW`, not `CANCEL_ALL_TIF_INVALID`.
 * - **`ApiKeyIndex = 255` is legal**, and only here: it means "cancel across every API key on the
 *   account".
 *
 * The per-market selector is attribute type 5, not a struct field, and it is only legal alongside
 * `ImmediateCancelAll` (`docs/protocol-notes.md` §11). Value `255` means "all markets" and is
 * exempt from that rule, which is why the predicate has three terms.
 *
 * `MinOrderCancelAllPeriod` / `MaxOrderCancelAllPeriod` are advisory and deliberately unenforced.
 *
 * @throws {LighterValidationError} the §12 code of the first violated rule.
 */
export function validateCancelAllOrders(tx: CancelAllOrdersTx, opts?: OrderValidateOptions): void {
  // `strict` gates no additional rule for this transaction — see {@link OrderValidateOptions}.
  void opts;
  const txType: number = TxType.L2CancelAllOrders;

  validateAttributes(tx.attributes);
  checkAccountIndex(tx.accountIndex, txType);
  checkApiKeyIndex(tx.apiKeyIndex, txType, true);

  // Out of order relative to every other transaction, on purpose.
  checkNonce(tx.nonce, txType);
  checkExpiredAt(tx.expiredAt, txType);

  const attributes: TxAttributes | undefined = tx.attributes;
  const perMarket: number | undefined =
    attributes === undefined ? undefined : attributes[CANCEL_ALL_MARKET_ATTRIBUTE];
  if (
    perMarket !== undefined &&
    tx.timeInForce !== CancelAllTimeInForce.ImmediateCancelAll &&
    perMarket !== NIL_MARKET_INDEX
  ) {
    fail("CANCEL_ALL_MARKET_CANT_BE_SCHEDULED", MSG_CANCEL_ALL_MARKET_CANT_BE_SCHEDULED, {
      field: "TimeInForce",
      txType,
    });
  }

  const tif: number = tx.timeInForce;
  switch (tif) {
    case CancelAllTimeInForce.ImmediateCancelAll:
    case CancelAllTimeInForce.AbortScheduledCancelAll: {
      if (tx.time !== ZERO) {
        fail("CANCEL_ALL_TIME_NOT_NIL", MSG_CANCEL_ALL_TIME_NOT_NIL, { field: "Time", txType });
      }
      return;
    }
    case CancelAllTimeInForce.ScheduledCancelAll: {
      if (tx.time < MIN_CANCEL_ALL_TIME || tx.time > MAX_CANCEL_ALL_TIME) {
        fail("CANCEL_ALL_TIME_OUT_OF_RANGE", MSG_CANCEL_ALL_TIME_OUT_OF_RANGE, {
          field: "Time",
          txType,
        });
      }
      return;
    }
    default:
      fail("CANCEL_ALL_TIF_INVALID", MSG_CANCEL_ALL_TIF_INVALID, { field: "TimeInForce", txType });
  }
}

/**
 * Validate an `L2ModifyOrder` (type 17) — `spec/04-tx-types.md` §7.11.
 *
 * A modification carries no side, time-in-force, order type or expiry, so none of the per-order
 * matrix applies. `BaseAmount = 0` here means "leave the size unchanged" and is always legal —
 * unlike `L2CreateOrder`, where a nil size requires `ReduceOnly = 1`.
 *
 * @throws {LighterValidationError} the §12 code of the first violated rule.
 */
export function validateModifyOrder(tx: ModifyOrderTx, opts?: OrderValidateOptions): void {
  // `strict` gates no additional rule for this transaction — see {@link OrderValidateOptions}.
  void opts;
  const txType: number = TxType.L2ModifyOrder;

  validateAttributes(tx.attributes);
  checkAccountIndex(tx.accountIndex, txType);
  checkApiKeyIndex(tx.apiKeyIndex, txType, false);
  checkMarketIndex(tx.marketIndex, txType);

  // §7.11 / ADR-13: the CLIENT_ORDER_INDEX_* pair, for the same predicate `L2CancelOrder` reports
  // as ORDER_INDEX_*. Reproduced deliberately — see the mirror comment in `validateCancelOrder`.
  if (tx.index < MIN_ANY_ORDER_INDEX) {
    fail("CLIENT_ORDER_INDEX_TOO_LOW", MSG_CLIENT_ORDER_INDEX_TOO_LOW, {
      field: "Index",
      txType,
      bound: MIN_ANY_ORDER_INDEX,
    });
  }
  if (tx.index > MAX_ANY_ORDER_INDEX) {
    fail("CLIENT_ORDER_INDEX_TOO_HIGH", MSG_CLIENT_ORDER_INDEX_TOO_HIGH, {
      field: "Index",
      txType,
      bound: MAX_ANY_ORDER_INDEX,
    });
  }

  if (tx.baseAmount !== NIL_ORDER_BASE_AMOUNT && tx.baseAmount < MIN_ORDER_BASE_AMOUNT) {
    fail("BASE_AMOUNT_TOO_LOW", MSG_BASE_AMOUNT_TOO_LOW, {
      field: "BaseAmount",
      txType,
      bound: MIN_ORDER_BASE_AMOUNT,
    });
  }
  if (tx.baseAmount > MAX_ORDER_BASE_AMOUNT) {
    fail("BASE_AMOUNT_TOO_HIGH", MSG_BASE_AMOUNT_TOO_HIGH, {
      field: "BaseAmount",
      txType,
      bound: MAX_ORDER_BASE_AMOUNT,
    });
  }

  if (tx.price < MIN_ORDER_PRICE) {
    fail("PRICE_TOO_LOW", MSG_PRICE_TOO_LOW, { field: "Price", txType, bound: MIN_ORDER_PRICE });
  }
  if (tx.price > MAX_ORDER_PRICE) {
    fail("PRICE_TOO_HIGH", MSG_PRICE_TOO_HIGH, { field: "Price", txType, bound: MAX_ORDER_PRICE });
  }

  if (
    tx.triggerPrice !== NIL_ORDER_TRIGGER_PRICE &&
    (tx.triggerPrice < MIN_ORDER_TRIGGER_PRICE || tx.triggerPrice > MAX_ORDER_TRIGGER_PRICE)
  ) {
    fail("ORDER_TRIGGER_PRICE_INVALID", MSG_ORDER_TRIGGER_PRICE_INVALID, {
      field: "TriggerPrice",
      txType,
    });
  }

  checkNonce(tx.nonce, txType);
  checkExpiredAt(tx.expiredAt, txType);
}

/* -------------------------------------------------------------------------------------------------
 * Local helpers. Not exported: `grouped.ts` needs the three step functions above, not these, and a
 * shared `validate/common.ts` would let one transaction's check order leak into another's.
 * ---------------------------------------------------------------------------------------------- */

/** Throw the §12 error for a violated rule. Returns `never` so call sites read as guards. */
function fail(
  code: LighterValidationCode,
  message: string,
  options: LighterValidationErrorOptions,
): never {
  throw new LighterValidationError(code, message, options);
}

function failTif(): never {
  fail("ORDER_TIF_INVALID", MSG_ORDER_TIF_INVALID, { field: "TimeInForce" });
}

function failTrigger(): never {
  fail("ORDER_TRIGGER_PRICE_INVALID", MSG_ORDER_TRIGGER_PRICE_INVALID, { field: "TriggerPrice" });
}

function failExpiry(): never {
  fail("ORDER_EXPIRY_INVALID", MSG_ORDER_EXPIRY_INVALID, { field: "OrderExpiry" });
}

function failType(): never {
  fail("ORDER_TYPE_INVALID", MSG_ORDER_TYPE_INVALID, { field: "Type" });
}

/** `[-1, 2^48 - 2]`. `-1` is `MinAccountIndex` and is a legal account, not an absence. */
function checkAccountIndex(accountIndex: bigint, txType: number): void {
  if (accountIndex < MIN_ACCOUNT_INDEX) {
    fail("ACCOUNT_INDEX_TOO_LOW", MSG_ACCOUNT_INDEX_TOO_LOW, {
      field: "AccountIndex",
      txType,
      bound: MIN_ACCOUNT_INDEX,
    });
  }
  if (accountIndex > MAX_ACCOUNT_INDEX) {
    fail("ACCOUNT_INDEX_TOO_HIGH", MSG_ACCOUNT_INDEX_TOO_HIGH, {
      field: "AccountIndex",
      txType,
      bound: MAX_ACCOUNT_INDEX,
    });
  }
}

/**
 * `[0, 254]`, plus `255` when `allowNil` — which is true for `L2CancelAllOrders` and nothing else.
 *
 * The reference spells the upper check `ApiKeyIndex > 254 && ApiKeyIndex != 255`, so `255` is
 * carved out of an otherwise ordinary bound rather than range-checked separately.
 */
function checkApiKeyIndex(apiKeyIndex: number, txType: number, allowNil: boolean): void {
  if (apiKeyIndex < MIN_API_KEY_INDEX) {
    fail("API_KEY_INDEX_TOO_LOW", MSG_API_KEY_INDEX_TOO_LOW, {
      field: "ApiKeyIndex",
      txType,
      bound: MIN_API_KEY_INDEX,
    });
  }
  if (apiKeyIndex > MAX_API_KEY_INDEX && !(allowNil && apiKeyIndex === NIL_API_KEY_INDEX)) {
    fail("API_KEY_INDEX_TOO_HIGH", MSG_API_KEY_INDEX_TOO_HIGH, {
      field: "ApiKeyIndex",
      txType,
      bound: MAX_API_KEY_INDEX,
    });
  }
}

/** The step-5 gate: perps or spot, nothing between and nothing outside. */
function checkMarketIndex(marketIndex: number, txType: number): MarketKind {
  const kind: MarketKind | null = marketKind(marketIndex);
  if (kind === null) {
    fail("MARKET_INDEX_INVALID", MSG_MARKET_INDEX_INVALID, { field: "MarketIndex", txType });
  }
  return kind;
}

/** `Nonce >= 0`. There is no upper bound beyond the `int64` width. */
function checkNonce(nonce: bigint, txType: number): void {
  if (nonce < MIN_NONCE) {
    fail("NONCE_TOO_LOW", MSG_NONCE_TOO_LOW, { field: "Nonce", txType, bound: MIN_NONCE });
  }
}

/**
 * `[0, 2^48 - 1]`.
 *
 * One higher than {@link MAX_ACCOUNT_INDEX}, which is `2^48 - 2`. The two constants differ by one
 * and look identical at a glance; {@link MAX_TIMESTAMP} is the right one here.
 */
function checkExpiredAt(expiredAt: bigint, txType: number): void {
  if (expiredAt < ZERO || expiredAt > MAX_TIMESTAMP) {
    fail("EXPIRED_AT_INVALID", MSG_EXPIRED_AT_INVALID, {
      field: "ExpiredAt",
      txType,
      bound: MAX_TIMESTAMP,
    });
  }
}
