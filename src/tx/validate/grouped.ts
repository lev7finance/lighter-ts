/**
 * Local validation for `L2CreateGroupedOrders` (type 28) — `spec/04-tx-types.md` §7.12 and §8.
 *
 * A grouped order is 2 or 3 `OrderInfo` legs the exchange treats as one conditional structure:
 * OTO (one triggers the other), OCO (one cancels the other), OTOCO (a parent plus an OCO pair).
 * The reference validator enforces the shape strictly, and — this is the part that catches people —
 * **the three groupings disagree on almost every axis**:
 *
 * | | OTO (1) | OCO (2) | OTOCO (3) |
 * | --- | --- | --- | --- |
 * | legs | exactly 2 | exactly 2 | exactly 3 |
 * | size | `Orders[1].BaseAmount === 0` | `Orders[0].BaseAmount === Orders[1].BaseAmount` | `Orders[1]` and `Orders[2]` both `0` |
 * | side | parent **opposite** child | both legs **same** side | parent opposite **each** child |
 * | reduce-only | not required | **both must be 1** | not required |
 * | expiry | agree *if* the parent's is set | equal, unconditionally | children equal; parent agrees if set |
 * | types | parent on `[0]`, child on `[1]` | sibling pair | parent on `[0]`, sibling pair on `[1..2]` |
 *
 * "Same side" for OCO is not a typo. A take-profit and a stop-loss protecting one long position are
 * both sells, so an OCO pair shares a direction while an OTO parent/child pair opposes.
 *
 * ## What is deliberately *not* reused from `./orders.ts`
 *
 * {@link validateOrderCore} and {@link validateTriggerPriceRange} are shared, because §8.2's
 * per-leg loop is §7.8's per-order loop. `validateOrderTypeMatrix` is **not**: a grouped leg is
 * judged by the parent rules (§8.3) or the child rules (§8.4) according to its position in the
 * array, and the create-order matrix would reject every valid child — a bare `Type: 2` leg with
 * `BaseAmount = 0` is exactly what a position-tied stop-loss looks like inside a group.
 *
 * ## Check order is normative
 *
 * As everywhere in `src/tx/validate`, the reference returns on the first violated predicate, so the
 * sequence decides which `code` a doubly-invalid transaction reports. §8.2 runs first, in full, and
 * only then does the `switch` on `GroupingType` reach §8.5. Two consequences worth stating:
 *
 * - **Length is checked twice with the same error and different bounds.** §8.2 rejects `0` or `> 3`
 *   legs up front; each grouping arm then re-asserts its own exact count. A 2-leg OTOCO is legal at
 *   the §8.2 gate and fails *inside* the switch.
 * - **Only leg 0 is gated on being a perps market.** Every other leg is compared against
 *   `Orders[0].MarketIndex` only, so a spot index on leg 1 surfaces as `MARKET_INDEX_MISMATCH`
 *   rather than `MARKET_INDEX_INVALID`. Spot is therefore impossible by construction, which is why
 *   {@link validateOrderCore} is called with `isSpot: false`.
 *
 * ## Leg order is load-bearing
 *
 * The aggregated leg hash is a left fold seeded with leg 0 (`docs/protocol-notes.md` §4), so
 * swapping two legs changes the transaction hash. Nothing here sorts, de-duplicates or otherwise
 * normalises `tx.orders`; every function in this module is side-effect-free on its input.
 */

import { LighterValidationError } from "../../errors.js";
import type { LighterValidationCode, LighterValidationErrorOptions } from "../../errors.js";
import { validateAttributes } from "../attributes.js";
import {
  MAX_ACCOUNT_INDEX,
  MAX_API_KEY_INDEX,
  MAX_CLIENT_ORDER_INDEX,
  MAX_GROUPED_ORDER_COUNT,
  MAX_TIMESTAMP,
  MIN_ACCOUNT_INDEX,
  MIN_API_KEY_INDEX,
  MIN_CLIENT_ORDER_INDEX,
  MIN_NONCE,
  NIL_CLIENT_ORDER_INDEX,
  NIL_ORDER_BASE_AMOUNT,
  NIL_ORDER_EXPIRY,
  NIL_ORDER_TRIGGER_PRICE,
} from "../constants.js";
import { GroupingType, OrderTimeInForce, OrderType, TxType } from "../enums.js";
import type { CreateGroupedOrdersTx, OrderInfo } from "../types/orders.js";
import { marketKind, validateOrderCore, validateTriggerPriceRange } from "./orders.js";
import type { MarketKind, OrderValidateOptions } from "./orders.js";

/* -------------------------------------------------------------------------------------------------
 * Messages — `spec/04-tx-types.md` §12, verbatim, plus the one code this SDK adds.
 * ---------------------------------------------------------------------------------------------- */

const MSG_ACCOUNT_INDEX_TOO_LOW: string = "AccountIndex should not be less than -1";
const MSG_ACCOUNT_INDEX_TOO_HIGH: string =
  "AccountIndex should not be larger than 281474976710654";
const MSG_API_KEY_INDEX_TOO_LOW: string = "ApiKeyIndex should not be less than 0";
const MSG_API_KEY_INDEX_TOO_HIGH: string = "ApiKeyIndex should not be larger than 254";
const MSG_NONCE_TOO_LOW: string = "AccountNonce should not be less than 0";
const MSG_EXPIRED_AT_INVALID: string = "ExpiredAt is invalid";
const MSG_MARKET_INDEX_INVALID: string = "MarketIndex is not valid";
const MSG_MARKET_INDEX_MISMATCH: string = "MarketIndex should match the market index of the order";
const MSG_CLIENT_ORDER_INDEX_TOO_LOW: string = "ClientOrderIndex should not be less than 1";
const MSG_CLIENT_ORDER_INDEX_TOO_HIGH: string =
  "ClientOrderIndex should not be larger than 281474976710655";
const MSG_CLIENT_ORDER_INDEX_DUPLICATE: string = "ClientOrderIndex should be unique within the group";
const MSG_BASE_AMOUNTS_NOT_EQUAL: string = "BaseAmounts should be equal";
const MSG_BASE_AMOUNT_NOT_NIL: string = "BaseAmount should be nil";
const MSG_IS_ASK_INVALID: string = "IsAsk should be 0 or 1";
const MSG_ORDER_TIF_INVALID: string = "OrderTimeInForce is not valid";
const MSG_ORDER_REDUCE_ONLY_INVALID: string = "ReduceOnly is invalid";
const MSG_ORDER_EXPIRY_INVALID: string = "OrderExpiry is invalid";
const MSG_ORDER_TRIGGER_PRICE_INVALID: string = "TriggerPrice is invalid";
const MSG_ORDER_TYPE_INVALID: string = "OrderType is not valid";
const MSG_GROUPING_TYPE_INVALID: string = "GroupingType is not valid";
const MSG_ORDER_GROUP_SIZE_INVALID: string = "OrderGroupSize is not valid";

/**
 * §8.6 / §15 row 8. The reference documents this in a comment and does not enforce it; the message
 * is ours because there is no reference sentinel to quote.
 */
const MSG_CHILD_REDUCE_ONLY_MISMATCH: string =
  "Child orders should be ReduceOnly when the parent order is ReduceOnly";

/* -------------------------------------------------------------------------------------------------
 * Local domain values
 * ---------------------------------------------------------------------------------------------- */

/** `Nonce` and `ExpiredAt` nil / floor value. */
const ZERO: bigint = 0n;

/** The smallest legal group after §8.2: `Orders.length === 0` is rejected, `1` is not (yet). */
const MIN_GROUPED_ORDER_COUNT: 1 = 1;

/** `ReduceOnly` on. */
const REDUCE_ONLY_ON: 1 = 1;

/** Exact leg counts per grouping type (§8.1). */
const OTO_LEG_COUNT: 2 = 2;
const OCO_LEG_COUNT: 2 = 2;
const OTOCO_LEG_COUNT: 3 = 3;

/** `L2CreateGroupedOrders`. Stamped on every check this module owns. */
const TX_TYPE: number = TxType.L2CreateGroupedOrders;

/* -------------------------------------------------------------------------------------------------
 * Public surface
 * ---------------------------------------------------------------------------------------------- */

/**
 * Validate an `L2CreateGroupedOrders` (type 28) — `spec/04-tx-types.md` §8.2 then §8.5.
 *
 * ```text
 * attributes -> accountIndex -> apiKeyIndex -> group size -> leg-0 perps gate
 *   -> per leg: market match, clientOrderIndex bounds + duplicate, order core, trigger range
 *   -> nonce -> expiredAt
 *   -> switch GroupingType: OTO (§8.5) | OCO (§8.5) | OTOCO (§8.5) | default GROUPING_TYPE_INVALID
 * ```
 *
 * `GroupingType = 0` is `GroupingType.None`, the base sentinel, and always falls through to the
 * `default` arm — it is not "ungrouped", it is invalid.
 *
 * @param tx the transaction to check. Never mutated, and its `orders` array is never reordered.
 * @param opts `strict` defaults to `true` and gates only the §8.6 child reduce-only rule. With
 * `{ strict: false }` this function accepts exactly what the reference accepts.
 * @throws {LighterValidationError} the §12 code of the first violated rule.
 */
export function validateCreateGroupedOrders(
  tx: CreateGroupedOrdersTx,
  opts?: OrderValidateOptions,
): void {
  const strict: boolean = opts?.strict !== false;

  validateAttributes(tx.attributes);

  if (tx.accountIndex < MIN_ACCOUNT_INDEX) {
    fail("ACCOUNT_INDEX_TOO_LOW", MSG_ACCOUNT_INDEX_TOO_LOW, {
      field: "AccountIndex",
      txType: TX_TYPE,
      bound: MIN_ACCOUNT_INDEX,
    });
  }
  if (tx.accountIndex > MAX_ACCOUNT_INDEX) {
    fail("ACCOUNT_INDEX_TOO_HIGH", MSG_ACCOUNT_INDEX_TOO_HIGH, {
      field: "AccountIndex",
      txType: TX_TYPE,
      bound: MAX_ACCOUNT_INDEX,
    });
  }

  // `255` (`NilApiKeyIndex`) is legal for `L2CancelAllOrders` and for nothing else, so no carve-out.
  if (tx.apiKeyIndex < MIN_API_KEY_INDEX) {
    fail("API_KEY_INDEX_TOO_LOW", MSG_API_KEY_INDEX_TOO_LOW, {
      field: "ApiKeyIndex",
      txType: TX_TYPE,
      bound: MIN_API_KEY_INDEX,
    });
  }
  if (tx.apiKeyIndex > MAX_API_KEY_INDEX) {
    fail("API_KEY_INDEX_TOO_HIGH", MSG_API_KEY_INDEX_TOO_HIGH, {
      field: "ApiKeyIndex",
      txType: TX_TYPE,
      bound: MAX_API_KEY_INDEX,
    });
  }

  // The loose gate. Each grouping arm re-asserts its exact count below, with the same code.
  const orders: readonly OrderInfo[] = tx.orders;
  if (orders.length < MIN_GROUPED_ORDER_COUNT || orders.length > MAX_GROUPED_ORDER_COUNT) {
    failGroupSize();
  }

  // Only leg 0 is gated on the market family, and only against the *perps* window: grouped orders
  // are perps-only, so `255` (nil) and the whole spot range are `MARKET_INDEX_INVALID` here.
  const first: OrderInfo = leg(orders, 0);
  const kind: MarketKind | null = marketKind(first.marketIndex);
  if (kind !== "perps") {
    fail("MARKET_INDEX_INVALID", MSG_MARKET_INDEX_INVALID, {
      field: "MarketIndex",
      txType: TX_TYPE,
    });
  }

  // `0` is the nil client order index and is exempt from both the bounds and the duplicate check,
  // so a group whose every leg carries `0` is legal.
  const seen: Set<bigint> = new Set<bigint>();
  for (const o of orders) {
    if (o.marketIndex !== first.marketIndex) {
      fail("MARKET_INDEX_MISMATCH", MSG_MARKET_INDEX_MISMATCH, {
        field: "MarketIndex",
        txType: TX_TYPE,
      });
    }

    if (o.clientOrderIndex !== NIL_CLIENT_ORDER_INDEX) {
      if (o.clientOrderIndex < MIN_CLIENT_ORDER_INDEX) {
        fail("CLIENT_ORDER_INDEX_TOO_LOW", MSG_CLIENT_ORDER_INDEX_TOO_LOW, {
          field: "ClientOrderIndex",
          txType: TX_TYPE,
          bound: MIN_CLIENT_ORDER_INDEX,
        });
      }
      if (o.clientOrderIndex > MAX_CLIENT_ORDER_INDEX) {
        fail("CLIENT_ORDER_INDEX_TOO_HIGH", MSG_CLIENT_ORDER_INDEX_TOO_HIGH, {
          field: "ClientOrderIndex",
          txType: TX_TYPE,
          bound: MAX_CLIENT_ORDER_INDEX,
        });
      }
      if (seen.has(o.clientOrderIndex)) {
        fail("CLIENT_ORDER_INDEX_DUPLICATE", MSG_CLIENT_ORDER_INDEX_DUPLICATE, {
          field: "ClientOrderIndex",
          txType: TX_TYPE,
        });
      }
      seen.add(o.clientOrderIndex);
    }

    // Steps 8-16 of §7.8, which §8.2 repeats verbatim per leg. Spot is impossible by construction.
    validateOrderCore(o, { isSpot: false });
    // §8.2 checks the trigger *range* inside the leg loop — unlike §7.8, where it trails the type
    // matrix. Here there is no matrix yet: the parent/child rules run after the switch.
    validateTriggerPriceRange(o);
  }

  if (tx.nonce < MIN_NONCE) {
    fail("NONCE_TOO_LOW", MSG_NONCE_TOO_LOW, {
      field: "Nonce",
      txType: TX_TYPE,
      bound: MIN_NONCE,
    });
  }
  if (tx.expiredAt < ZERO || tx.expiredAt > MAX_TIMESTAMP) {
    fail("EXPIRED_AT_INVALID", MSG_EXPIRED_AT_INVALID, {
      field: "ExpiredAt",
      txType: TX_TYPE,
      bound: MAX_TIMESTAMP,
    });
  }

  // Widened out of its brand so the `case` labels stay plain numeric literals.
  const grouping: number = tx.groupingType;
  switch (grouping) {
    case GroupingType.OneTriggersTheOther:
      validateOto(orders, strict);
      return;
    case GroupingType.OneCancelsTheOther:
      validateOco(orders);
      return;
    case GroupingType.OneTriggersAOneCancelsTheOther:
      validateOtoco(orders, strict);
      return;
    // `GroupingType.None` (0) lands here, as does anything above 3.
    default:
      fail("GROUPING_TYPE_INVALID", MSG_GROUPING_TYPE_INVALID, {
        field: "GroupingType",
        txType: TX_TYPE,
      });
  }
}

/**
 * §8.3 — the rules for `Orders[0]` of an OTO or an OTOCO.
 *
 * Only `Limit (0)` and `Market (1)` may be parents. The set is closed: a `Twap (6)` parent is
 * rejected even though `Twap` is a legal standalone order type, because a TWAP cannot trigger a
 * child.
 *
 * These restate the create-order matrix rather than reusing it — the coupling for a `Limit` parent
 * runs in **both** directions (`TIF === IOC ⇔ OrderExpiry === 0`), so an IOC parent carrying an
 * expiry and a GTT parent carrying none are both `ORDER_EXPIRY_INVALID`.
 *
 * @throws {LighterValidationError} `ORDER_TYPE_INVALID`, `ORDER_TIF_INVALID`,
 * `ORDER_EXPIRY_INVALID` or `ORDER_TRIGGER_PRICE_INVALID`.
 */
export function validateParentOrder(o: OrderInfo): void {
  const hasTrigger: boolean = o.triggerPrice !== NIL_ORDER_TRIGGER_PRICE;
  const hasExpiry: boolean = o.orderExpiry !== NIL_ORDER_EXPIRY;
  const isIoc: boolean = o.timeInForce === OrderTimeInForce.ImmediateOrCancel;
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
      if (isIoc && hasExpiry) failExpiry();
      if (!isIoc && !hasExpiry) failExpiry();
      return;
    }
    default:
      failType();
  }
}

/**
 * §8.4 — the rules for a child leg.
 *
 * Only the four trigger types may be children: `StopLoss (2)`, `StopLossLimit (3)`,
 * `TakeProfit (4)`, `TakeProfitLimit (5)`. The parent and child sets are disjoint and both closed,
 * so a `Limit (0)` child is `ORDER_TYPE_INVALID`.
 *
 * The asymmetry between `2`/`4` and `3`/`5` is load-bearing and mirrors §7.8's matrix: the *market*
 * trigger variants must be IOC, the *limit* trigger variants carry **no** time-in-force constraint.
 * All three grouped vectors use `TimeInForce: 0` on their children, so a wrongly-applied IOC rule
 * on types `3`/`5` is invisible to the conformance vectors and is caught only by a written test.
 *
 * @throws {LighterValidationError} `ORDER_TYPE_INVALID`, `ORDER_TIF_INVALID`,
 * `ORDER_TRIGGER_PRICE_INVALID` or `ORDER_EXPIRY_INVALID`.
 */
export function validateChildOrder(o: OrderInfo): void {
  const hasTrigger: boolean = o.triggerPrice !== NIL_ORDER_TRIGGER_PRICE;
  const hasExpiry: boolean = o.orderExpiry !== NIL_ORDER_EXPIRY;
  const isIoc: boolean = o.timeInForce === OrderTimeInForce.ImmediateOrCancel;
  const orderType: number = o.type;

  switch (orderType) {
    case OrderType.StopLoss:
    case OrderType.TakeProfit: {
      if (!isIoc) failTif();
      if (!hasTrigger) failTrigger();
      if (!hasExpiry) failExpiry();
      return;
    }
    case OrderType.StopLossLimit:
    case OrderType.TakeProfitLimit: {
      // No time-in-force constraint here. See the note above before adding one.
      if (!hasTrigger) failTrigger();
      if (!hasExpiry) failExpiry();
      return;
    }
    default:
      failType();
  }
}

/**
 * §8.4's sibling-pair rule, used by OCO and by OTOCO's tail pair.
 *
 * Both legs must be valid children, and the pair must contain exactly one stop-loss-family member
 * (`2` or `3`) and one take-profit-family member (`4` or `5`). Two stop-losses — or two
 * take-profits — is `ORDER_TYPE_INVALID`, not a size or side error, because the structure would
 * have no exit on one side. Mixing the market and limit variants across the families is fine:
 * `3` + `4` is a legal pair.
 *
 * @throws {LighterValidationError} `ORDER_TYPE_INVALID`, or whichever code
 * {@link validateChildOrder} raises first.
 */
export function validateSiblingPair(a: OrderInfo, b: OrderInfo): void {
  validateChildOrder(a);
  validateChildOrder(b);
  if (isStopLossFamily(a) === isStopLossFamily(b)) failType();
}

/* -------------------------------------------------------------------------------------------------
 * Per-grouping rules — `spec/04-tx-types.md` §8.5, in the order written there.
 * ---------------------------------------------------------------------------------------------- */

/**
 * OTO (1): `[parent, child]`. The child's size is nil because it inherits whatever the parent
 * filled, and it faces the other way because it closes what the parent opened.
 */
function validateOto(orders: readonly OrderInfo[], strict: boolean): void {
  if (orders.length !== OTO_LEG_COUNT) failGroupSize();
  const parent: OrderInfo = leg(orders, 0);
  const child: OrderInfo = leg(orders, 1);

  // §8.6, strict only. Ahead of §8.5's rules by necessity — see {@link checkChildReduceOnly}.
  if (strict) checkChildReduceOnly(parent, [child]);

  // 1. The child carries no size of its own. The parent may be sized or nil.
  if (child.baseAmount !== NIL_ORDER_BASE_AMOUNT) failBaseAmountNotNil();
  // 2. Opposite directions.
  if (parent.isAsk === child.isAsk) failIsAsk();
  // 3. A nil parent expiry imposes nothing; a set one must match the child's exactly.
  if (parent.orderExpiry !== NIL_ORDER_EXPIRY && parent.orderExpiry !== child.orderExpiry) {
    failGroupExpiry();
  }
  // 4-5.
  validateParentOrder(parent);
  validateChildOrder(child);
}

/**
 * OCO (2): `[sibling, sibling]`. Both legs protect one existing position, so they share a side and
 * a size, must both be reduce-only, and expire together.
 */
function validateOco(orders: readonly OrderInfo[]): void {
  if (orders.length !== OCO_LEG_COUNT) failGroupSize();
  const a: OrderInfo = leg(orders, 0);
  const b: OrderInfo = leg(orders, 1);

  // 1. Equal sizes — and `0 === 0` is the common case, a position-tied pair.
  if (a.baseAmount !== b.baseAmount) {
    fail("BASE_AMOUNTS_NOT_EQUAL", MSG_BASE_AMOUNTS_NOT_EQUAL, {
      field: "BaseAmount",
      txType: TX_TYPE,
    });
  }
  // 2. Same direction. Not a typo: a take-profit and a stop-loss on one long are both sells.
  if (a.isAsk !== b.isAsk) failIsAsk();
  // 3. Both reduce-only, unconditionally.
  if (a.reduceOnly !== REDUCE_ONLY_ON || b.reduceOnly !== REDUCE_ONLY_ON) {
    fail("ORDER_REDUCE_ONLY_INVALID", MSG_ORDER_REDUCE_ONLY_INVALID, {
      field: "ReduceOnly",
      txType: TX_TYPE,
    });
  }
  // 4. Identical expiry — unlike OTO, this holds even when both are nil, which is trivially true.
  if (a.orderExpiry !== b.orderExpiry) failGroupExpiry();
  // 5.
  validateSiblingPair(a, b);

  // §8.6 does not apply: an OCO has no parent, and rule 3 already forces both legs reduce-only.
}

/**
 * OTOCO (3): `[parent, sibling, sibling]` — an OTO whose child is replaced by an OCO pair.
 *
 * Note the expiry rules are ordered children-first: two children with different expiries report
 * `ORDER_EXPIRY_INVALID` from rule 3, before the parent is ever consulted.
 */
function validateOtoco(orders: readonly OrderInfo[], strict: boolean): void {
  if (orders.length !== OTOCO_LEG_COUNT) failGroupSize();
  const parent: OrderInfo = leg(orders, 0);
  const first: OrderInfo = leg(orders, 1);
  const second: OrderInfo = leg(orders, 2);

  // §8.6, strict only. Ahead of §8.5's rules by necessity — see {@link checkChildReduceOnly}.
  if (strict) checkChildReduceOnly(parent, [first, second]);

  // 1. Both children nil-sized.
  if (
    first.baseAmount !== NIL_ORDER_BASE_AMOUNT ||
    second.baseAmount !== NIL_ORDER_BASE_AMOUNT
  ) {
    failBaseAmountNotNil();
  }
  // 2. The parent opposes each child — which, with rule 5 of the OCO shape absent here, is what
  //    keeps the two children on the same side as each other.
  if (parent.isAsk === first.isAsk || parent.isAsk === second.isAsk) failIsAsk();
  // 3. The children share an expiry.
  if (first.orderExpiry !== second.orderExpiry) failGroupExpiry();
  // 4. A set parent expiry must match them.
  if (parent.orderExpiry !== NIL_ORDER_EXPIRY && parent.orderExpiry !== first.orderExpiry) {
    failGroupExpiry();
  }
  // 5-6.
  validateParentOrder(parent);
  validateSiblingPair(first, second);
}

/* -------------------------------------------------------------------------------------------------
 * Local helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * §8.6 / §15 row 8 — the invariant the reference states in a comment and never checks.
 *
 * If the parent is `ReduceOnly = 1` every child must be too, or the sequencer's
 * `CancelPositionTiedAccountOrders` flow leaves an orphaned child behind.
 *
 * ## Why this runs *before* §8.5 and not after it
 *
 * A child with `ReduceOnly = 0` and `BaseAmount = 0` is already rejected by §8.2's core rule
 * (`ReduceOnly !== 1 && BaseAmount === 0` → `BASE_AMOUNT_TOO_LOW`), and OTO/OTOCO both require
 * their children to be nil-sized. So the only child that can be non-reduce-only is a *sized* one,
 * and a sized child is `BASE_AMOUNT_NOT_NIL` at rule 1 of the arm. Placed after §8.5 this function
 * would be unreachable — dead code that silently satisfies its own unit test.
 *
 * Running it first therefore costs one thing and buys another: a transaction with a reduce-only
 * parent and a sized, non-reduce-only child reports `CHILD_REDUCE_ONLY_MISMATCH` in strict mode
 * where the reference reports `BASE_AMOUNT_NOT_NIL`. That transaction is rejected either way — the
 * strict code just names the cause the caller actually needs to fix. `{ strict: false }` skips this
 * entirely and reproduces the reference byte for byte, per ADR-13 / §15 row 8.
 *
 * A non-reduce-only parent imposes nothing, which is why none of the three grouped vectors can trip
 * this in either mode.
 */
function checkChildReduceOnly(parent: OrderInfo, children: readonly OrderInfo[]): void {
  if (parent.reduceOnly !== REDUCE_ONLY_ON) return;
  for (const child of children) {
    if (child.reduceOnly !== REDUCE_ONLY_ON) {
      fail("CHILD_REDUCE_ONLY_MISMATCH", MSG_CHILD_REDUCE_ONLY_MISMATCH, {
        field: "ReduceOnly",
        txType: TX_TYPE,
      });
    }
  }
}

/** Stop-loss family is `{2, 3}`; take-profit family is `{4, 5}`. Callers have already type-checked. */
function isStopLossFamily(o: OrderInfo): boolean {
  const orderType: number = o.type;
  return orderType === OrderType.StopLoss || orderType === OrderType.StopLossLimit;
}

/**
 * Index a leg whose existence the caller has already established with a length check.
 *
 * `noUncheckedIndexedAccess` widens every element access to `| undefined`; the throw is unreachable
 * and reports the same code the length check would have.
 */
function leg(orders: readonly OrderInfo[], index: number): OrderInfo {
  const o: OrderInfo | undefined = orders[index];
  if (o === undefined) failGroupSize();
  return o;
}

/** Throw the §12 error for a violated rule. Returns `never` so call sites read as guards. */
function fail(
  code: LighterValidationCode,
  message: string,
  options: LighterValidationErrorOptions,
): never {
  throw new LighterValidationError(code, message, options);
}

function failGroupSize(): never {
  fail("ORDER_GROUP_SIZE_INVALID", MSG_ORDER_GROUP_SIZE_INVALID, {
    field: "Orders",
    txType: TX_TYPE,
  });
}

function failBaseAmountNotNil(): never {
  fail("BASE_AMOUNT_NOT_NIL", MSG_BASE_AMOUNT_NOT_NIL, { field: "BaseAmount", txType: TX_TYPE });
}

function failIsAsk(): never {
  fail("IS_ASK_INVALID", MSG_IS_ASK_INVALID, { field: "IsAsk", txType: TX_TYPE });
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

/**
 * Same code as {@link failExpiry}, stamped with `txType`.
 *
 * The split follows `./orders.ts`: a per-leg rule cannot claim a transaction type, because a leg of
 * a group is not an `L2CreateOrder` and is not an `L2CreateGroupedOrders` either. The *agreement*
 * rules of §8.5 are owned by the transaction, so those do carry it.
 */
function failGroupExpiry(): never {
  fail("ORDER_EXPIRY_INVALID", MSG_ORDER_EXPIRY_INVALID, {
    field: "OrderExpiry",
    txType: TX_TYPE,
  });
}

function failType(): never {
  fail("ORDER_TYPE_INVALID", MSG_ORDER_TYPE_INVALID, { field: "Type" });
}
