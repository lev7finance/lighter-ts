/**
 * Conditional order structures — OTO, OCO, OTOCO — built from ergonomic input, and the per-market
 * decimal conversions the whole human tier shares.
 *
 * Two things live here and they belong together.
 *
 * **The conversions.** A human says `"0.1"` and `"2500.00"`; the wire wants `1000` and `250000`. The
 * exponents come from the market registry, the parsing is lexical (`src/util/decimal.ts`), and the
 * rounding direction is named at every call site rather than defaulted globally. Nothing here
 * touches a binary floating-point value and nothing here rounds to nearest: the reference's
 * `int(price.replace(".", ""))` is correct only while the server pads to the market's declared
 * precision — `"2500.1"` would become `25001`, a 100× price error — and its `int(quote × 1e6)`
 * truncates a float error into `8_199_999` for `"8.2"` (`docs/protocol-notes.md` §9, hazards 2
 * and 3).
 *
 * **The group shapes.** A bracket is 2 or 3 legs the exchange treats as one structure, and the three
 * groupings disagree on almost every axis:
 *
 * | Grouping | Legs | Rules |
 * | --- | --- | --- |
 * | OTO (1) | exactly 2 | child size nil; opposite sides; expiries agree if the parent's is set |
 * | OCO (2) | exactly 2 | equal sizes; **same** side; both reduce-only; identical expiries; one SL-family and one TP-family leg |
 * | OTOCO (3) | exactly 3 | both children nil-sized and opposite the parent; children share an expiry; the parent's, if set, equals theirs |
 *
 * "Same side" for OCO is not a typo: a take-profit and a stop-loss protecting one long position are
 * both sells.
 *
 * ## The legality table is not reimplemented here
 *
 * {@link assertGroupLegality} builds a probe transaction and hands it to
 * `validateCreateGroupedOrders` — the same validator `account.tx.createGroupedOrders` runs, which is
 * the reference's own table transcribed once in `src/tx/validate/grouped.ts`. A second copy in this
 * file would be a second thing to keep in step with the sequencer, and the copy that drifts is
 * always the one that is not vector-pinned. What this file adds on top is the one rule the validator
 * cannot see: the *registry* knows a market is spot even where its index would pass a range check.
 *
 * Per-leg hashing and the pairwise fold belong to `src/tx/grouped-hash.ts` and are not touched here.
 *
 * ## Leg order is load-bearing
 *
 * The aggregated leg hash is a left fold seeded with leg 0 (`docs/protocol-notes.md` §4), so the
 * arrays these builders return are in protocol order — parent first, then stop-loss, then
 * take-profit — and nothing downstream sorts or de-duplicates them.
 *
 * Pure: no I/O, no module-level state, and the only clock read is the injected `now` an expiry
 * default needs.
 */

import { LighterValidationError } from "../errors.js";
import { i16, i64, u8, u32 } from "../tx/brands.js";
import {
  MAX_CLIENT_ORDER_INDEX,
  MAX_ORDER_BASE_AMOUNT,
  MAX_ORDER_EXPIRY,
  MAX_ORDER_PRICE,
  MIN_ORDER_BASE_AMOUNT,
  MIN_ORDER_PRICE,
  NIL_CLIENT_ORDER_INDEX,
  NIL_ORDER_BASE_AMOUNT,
  NIL_ORDER_EXPIRY,
} from "../tx/constants.js";
import { GroupingType, OrderTimeInForce, OrderType, TxType } from "../tx/enums.js";
import type { CreateGroupedOrdersTx, OrderInfo } from "../tx/types/orders.js";
import { validateCreateGroupedOrders } from "../tx/validate/grouped.js";
import { type RoundingMode, toScaled } from "../util/decimal.js";
import type { MarketInfo } from "./markets.js";

/* ---------------------------------------------------------------------------------------------- */
/* Vocabulary                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/** Which way an order faces, spelled the way a human says it. `sell` is `IsAsk = 1`. */
export type Side = "buy" | "sell";

/** Time in force, spelled the way `spec/07-high-level-client.md` §1.4 names it. */
export type TimeInForceName = "IOC" | "GTT" | "PostOnly";

/** Which of the two trigger families a leg belongs to. A stop and a target are not interchangeable. */
export type TriggerFamily = "stopLoss" | "takeProfit";

/**
 * What to do with a price or trigger that carries more precision than the market can express.
 *
 * - `exact` — refuse. The default everywhere, because a price the market cannot represent is
 *   usually the wrong market rather than a rounding question (`spec/07-high-level-client.md` §3.1).
 * - `conservative` — round the way that cannot cost the caller money: a **buy**'s price rounds
 *   **down** so they never pay more than they asked, a **sell**'s rounds **up** so they never accept
 *   less (§3.2).
 *
 * There is deliberately no way to ask for the opposite direction on a price a human typed.
 * `docs/decisions.md` D7's illustrative wording ("a buy's acceptable price rounds up") contradicts
 * the invariant stated in the same paragraph; the invariant wins. The *market-order* price cap is
 * not derived here at all — it is delegated whole to `slippageBound`.
 */
export type PriceRounding = "exact" | "conservative";

/**
 * The exact protocol integers one human-tier call resolved to.
 *
 * Reported by **every** human-tier method. A conversion the caller cannot see is a conversion they
 * cannot audit, and all four of the reference's arithmetic hazards are invisible at the call site.
 */
export interface Applied {
  /** `BaseAmount`, at the market's size precision. `0n` is `NilOrderBaseAmount` — "the whole position". */
  readonly baseAmount: bigint;
  /** `Price`, at the market's price precision. For a market order this is the slippage bound. */
  readonly price: bigint;
  /** `TriggerPrice`, at the market's price precision. `0n` is nil. */
  readonly triggerPrice: bigint;
  /** `OrderExpiry`, Unix **milliseconds**. `0n` is nil, and is the correct expiry for an IOC order. */
  readonly orderExpiry: bigint;
  /** The quote integer a quote-sized order resolved to, at the market's quote precision. */
  readonly notional?: bigint;
  /** Micro-USDC moved, on `addMargin` / `removeMargin`. */
  readonly usdcAmount?: bigint;
}

/** An {@link Applied} with every order field nil — a call that carries no order integers at all. */
export const NO_ORDER_INTEGERS: Applied = Object.freeze({
  baseAmount: NIL_ORDER_BASE_AMOUNT,
  price: 0n,
  triggerPrice: 0n,
  orderExpiry: NIL_ORDER_EXPIRY,
});

/* ---------------------------------------------------------------------------------------------- */
/* Expiries                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The reference's `DEFAULT_28_DAY_ORDER_EXPIRY`, expanded.
 *
 * The reference puts `-1` on the wire path and lets the far end expand it. `-1` is never a legal
 * `OrderExpiry` here: sentinels are expanded **at the boundary**, so what was signed and what was
 * meant are the same number (`spec/07-high-level-client.md` §1.5).
 */
export const DEFAULT_ORDER_EXPIRY_MS: bigint = 2_419_200_000n;

/** A duration, for {@link expiryIn}. Every field is optional and they sum. */
export interface Duration {
  readonly days?: number;
  readonly hours?: number;
  readonly minutes?: number;
  readonly seconds?: number;
  readonly ms?: number;
}

/**
 * An absolute `OrderExpiry` a duration from now — the replacement for the reference's `-1`.
 *
 * ```ts
 * handle.limit({ side: "buy", size: "0.1", price: "2500", expiry: expiryIn({ days: 28 }) });
 * ```
 *
 * Server-side an order expiry must land within `[now + 5 min, now + 30 days]`. That window belongs
 * to the sequencer and is not asserted here, because the clock this reads is the caller's.
 *
 * @throws {LighterValidationError} `ORDER_EXPIRY_INVALID` for a non-integer component or a total
 * that is not strictly positive.
 */
export function expiryIn(d: Duration, now: () => number = Date.now): bigint {
  const parts: readonly (readonly [number | undefined, bigint])[] = [
    [d.days, 86_400_000n],
    [d.hours, 3_600_000n],
    [d.minutes, 60_000n],
    [d.seconds, 1_000n],
    [d.ms, 1n],
  ];
  let total: bigint = 0n;
  for (const [value, scale] of parts) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value)) {
      throw new LighterValidationError(
        "ORDER_EXPIRY_INVALID",
        `a duration component must be a safe integer, received ${String(value)}`,
        { field: "OrderExpiry" },
      );
    }
    total += BigInt(value) * scale;
  }
  if (total <= 0n) {
    throw new LighterValidationError(
      "ORDER_EXPIRY_INVALID",
      "expiryIn() needs a strictly positive duration; 0 is NilOrderExpiry, a different instruction",
      { field: "OrderExpiry" },
    );
  }
  return assertExpiry(nowMs(now) + total);
}

/** The injected clock as whole milliseconds. Never a fractional timestamp on the wire. */
function nowMs(now: () => number): bigint {
  return BigInt(Math.trunc(now()));
}

/** `OrderExpiry` against its protocol domain. `0` (nil) is legal and passes through. */
function assertExpiry(expiry: bigint): bigint {
  if (expiry < NIL_ORDER_EXPIRY || expiry > MAX_ORDER_EXPIRY) {
    throw new LighterValidationError(
      "ORDER_EXPIRY_INVALID",
      `OrderExpiry must be within [0, ${MAX_ORDER_EXPIRY.toString()}] ms, received ${expiry.toString()}`,
      { field: "OrderExpiry", bound: MAX_ORDER_EXPIRY },
    );
  }
  return expiry;
}

/**
 * The `OrderExpiry` a leg carries: the caller's, or the default for its time in force.
 *
 * IOC is `NilOrderExpiry` — `0` is not "no expiry", it is the *correct* expiry for an
 * immediate-or-cancel order. Everything else defaults to 28 days from the injected clock.
 */
export function expiryFor(tif: number, expiry: bigint | undefined, now: () => number): bigint {
  if (expiry !== undefined) return assertExpiry(expiry);
  if (tif === OrderTimeInForce.ImmediateOrCancel) return NIL_ORDER_EXPIRY;
  return assertExpiry(nowMs(now) + DEFAULT_ORDER_EXPIRY_MS);
}

/* ---------------------------------------------------------------------------------------------- */
/* Human decimal → protocol integer                                                                 */
/* ---------------------------------------------------------------------------------------------- */

/** `sell` is `IsAsk = 1`; `buy` is `0`. */
export function isAskOf(side: Side): boolean {
  if (side === "sell") return true;
  if (side === "buy") return false;
  throw new LighterValidationError(
    "IS_ASK_INVALID",
    `side must be "buy" or "sell", received ${JSON.stringify(side)}`,
    { field: "IsAsk" },
  );
}

/** The opposite side — what a bracket's children face relative to its parent. */
export function opposite(side: Side): Side {
  return isAskOf(side) ? "buy" : "sell";
}

/**
 * A base size, at the market's size precision.
 *
 * **Always floored**, on both sides: rounding a size up trades more of the caller's money than they
 * asked for (`spec/07-high-level-client.md` §3.2). An omitted size is `NilOrderBaseAmount` — "the
 * whole position" — which the protocol accepts only on a reduce-only order.
 *
 * @throws {LighterValidationError} `BASE_AMOUNT_TOO_LOW` when a non-empty size floors to zero, which
 * would silently turn "trade a dust amount" into "trade the whole position".
 */
export function baseAmountOf(market: MarketInfo, size: string | undefined): bigint {
  if (size === undefined) return NIL_ORDER_BASE_AMOUNT;
  const scaled: bigint = toScaled(size, market.sizeDecimals, "FLOOR");
  if (scaled < MIN_ORDER_BASE_AMOUNT) {
    throw new LighterValidationError(
      "BASE_AMOUNT_TOO_LOW",
      `a size of ${JSON.stringify(size)} is below one tick on ${market.symbol} ` +
        `(${String(market.sizeDecimals)} size decimals); a zero base amount is NilOrderBaseAmount, ` +
        `which means "the whole position" rather than "nothing"`,
      { field: "BaseAmount", bound: MIN_ORDER_BASE_AMOUNT },
    );
  }
  if (scaled > MAX_ORDER_BASE_AMOUNT) {
    throw new LighterValidationError(
      "BASE_AMOUNT_TOO_HIGH",
      `a size of ${JSON.stringify(size)} exceeds MaxOrderBaseAmount at ${market.symbol}'s precision`,
      { field: "BaseAmount", bound: MAX_ORDER_BASE_AMOUNT },
    );
  }
  return scaled;
}

/**
 * A price, at the market's price precision, under an explicitly named direction.
 *
 * `exact` refuses a price the market cannot express; `conservative` rounds the way that cannot cost
 * the caller money.
 */
export function priceOf(
  market: MarketInfo,
  price: string,
  isAsk: boolean,
  rounding: PriceRounding = "exact",
  field: string = "Price",
): bigint {
  const scaled: bigint = toScaled(price, market.priceDecimals, priceRoundingMode(isAsk, rounding));
  if (scaled < BigInt(MIN_ORDER_PRICE)) {
    throw new LighterValidationError(
      "PRICE_TOO_LOW",
      `a price of ${JSON.stringify(price)} is below one tick on ${market.symbol} ` +
        `(${String(market.priceDecimals)} price decimals); price 0 is NilOrderPrice, not "any price"`,
      { field, bound: BigInt(MIN_ORDER_PRICE) },
    );
  }
  if (scaled > BigInt(MAX_ORDER_PRICE)) {
    throw new LighterValidationError(
      "PRICE_TOO_HIGH",
      `a price of ${JSON.stringify(price)} exceeds MaxOrderPrice at ${market.symbol}'s precision`,
      { field, bound: BigInt(MAX_ORDER_PRICE) },
    );
  }
  return scaled;
}

/**
 * A trigger price, at the market's price precision.
 *
 * The rounding direction follows the price direction of the order the trigger belongs to. A trigger
 * is not a price the caller pays, so there is no protection argument either way; matching the price
 * keeps one order's two thresholds from drifting apart by a tick.
 */
export function triggerOf(
  market: MarketInfo,
  trigger: string,
  isAsk: boolean,
  rounding: PriceRounding = "exact",
): bigint {
  return priceOf(market, trigger, isAsk, rounding, "TriggerPrice");
}

/** The rounding mode a price takes for one side under one policy. Never rounds to nearest. */
export function priceRoundingMode(isAsk: boolean, rounding: PriceRounding): RoundingMode {
  if (rounding === "exact") return "EXACT";
  if (rounding !== "conservative") {
    throw new LighterValidationError(
      "PRICE_ROUNDING_INVALID",
      `rounding must be "exact" or "conservative", received ${JSON.stringify(rounding)}`,
    );
  }
  // A sell's price is a floor it will not go below, so it rounds up; a buy's is a ceiling, so it
  // rounds down. Either direction can only tighten what the caller asked for.
  return isAsk ? "CEIL" : "FLOOR";
}

/** `TimeInForce` from its name. */
export function timeInForceOf(name: TimeInForceName | undefined, fallback: number): number {
  if (name === undefined) return fallback;
  switch (name) {
    case "IOC":
      return OrderTimeInForce.ImmediateOrCancel;
    case "GTT":
      return OrderTimeInForce.GoodTillTime;
    case "PostOnly":
      return OrderTimeInForce.PostOnly;
    default:
      throw new LighterValidationError(
        "ORDER_TIF_INVALID",
        `timeInForce must be "IOC", "GTT" or "PostOnly", received ${JSON.stringify(name)}`,
        { field: "TimeInForce" },
      );
  }
}

/** `ClientOrderIndex`: the caller's id, or `0` for "the server assigns one". */
export function clientOrderIndexOf(id: bigint | undefined): bigint {
  if (id === undefined) return NIL_CLIENT_ORDER_INDEX;
  if (typeof id !== "bigint") {
    throw new LighterValidationError(
      "CLIENT_ORDER_INDEX_TOO_LOW",
      "clientOrderId is an int64 and must be a bigint; a number cannot hold 2^48 − 1",
      { field: "ClientOrderIndex" },
    );
  }
  if (id !== NIL_CLIENT_ORDER_INDEX && (id < 1n || id > MAX_CLIENT_ORDER_INDEX)) {
    throw new LighterValidationError(
      "CLIENT_ORDER_INDEX_TOO_HIGH",
      `clientOrderId must be 0 (server-assigned) or within [1, ${MAX_CLIENT_ORDER_INDEX.toString()}]`,
      { field: "ClientOrderIndex", bound: MAX_CLIENT_ORDER_INDEX },
    );
  }
  return id;
}

/**
 * A range-checked `bigint` as the `number` a 16- or 32-bit branded constructor takes.
 *
 * Spelled through the decimal string rather than the usual numeric coercion, which this unit's float
 * gate forbids outright: on every other value in these files that coercion would be a defect. Here
 * the caller has already bounded the value inside the 32-bit width, where the conversion is exact.
 */
export function narrowToU32(v: bigint, field: string): number {
  if (v < 0n || v > BigInt(MAX_ORDER_PRICE)) {
    throw new LighterValidationError(
      "VALUE_TOO_HIGH",
      `${field} ${v.toString()} does not fit the protocol's 32-bit field`,
      { field, bound: BigInt(MAX_ORDER_PRICE) },
    );
  }
  return parseInt(v.toString(10), 10);
}

/* ---------------------------------------------------------------------------------------------- */
/* Leg options                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A bracket's entry leg: the order that opens the position the children protect.
 *
 * `market: true` makes it a MARKET parent, which the protocol requires to be IOC with a nil expiry
 * and a nil trigger. A MARKET parent still carries a price on the wire — its slippage bound — so
 * `price` is required there too; `MarketHandle.bracket` fills it from the book when the caller gives
 * a `maxSlippage` instead.
 */
export interface EntryOpts {
  readonly side: Side;
  /** Base units, decimal string. A nil size is legal only on a reduce-only order. */
  readonly size?: string;
  /** Limit price, decimal string. Also the slippage cap of a MARKET entry. */
  readonly price: string;
  /** `LIMIT` unless this is set. */
  readonly market?: boolean;
  /** Defaults to `GTT` for a limit entry; a market entry is forced to `IOC`. */
  readonly timeInForce?: TimeInForceName;
  readonly clientOrderId?: bigint;
  /** Absolute Unix ms. Use {@link expiryIn} for a relative one; `-1` is never accepted. */
  readonly expiry?: bigint;
  readonly reduceOnly?: boolean;
  readonly rounding?: PriceRounding;
}

/**
 * A stop-loss or take-profit leg.
 *
 * Both variants carry a **price** as well as a trigger: the market variants (`STOP_LOSS`,
 * `TAKE_PROFIT`) use it as the bound the triggered order is capped at, and the `*_LIMIT` variants
 * use it as the resting limit price. There is no nil price in this protocol.
 *
 * `side` is optional inside a bracket, where it is the opposite of the parent and stating it
 * differently is an error; it is required on a standalone `takeProfit()` / `stopLoss()`.
 */
export interface TriggerOpts {
  readonly side?: Side;
  /** Base units. Omitted is `NilOrderBaseAmount` — the whole position — which forces reduce-only. */
  readonly size?: string;
  /** The price that arms the order. */
  readonly triggerPrice: string;
  /** The price the armed order carries: a cap for the market variants, the limit for `*_LIMIT`. */
  readonly price: string;
  /** `true` selects `STOP_LOSS_LIMIT` / `TAKE_PROFIT_LIMIT`, whose time in force is unconstrained. */
  readonly limit?: boolean;
  /** Only meaningful for the `*_LIMIT` variants; the market variants must be IOC. */
  readonly timeInForce?: TimeInForceName;
  readonly clientOrderId?: bigint;
  /** Absolute Unix ms. The protocol requires a non-nil expiry here; defaults to 28 days out. */
  readonly expiry?: bigint;
  /** Defaults to `true` when `size` is omitted, because a nil size is legal only when reduce-only. */
  readonly reduceOnly?: boolean;
  readonly rounding?: PriceRounding;
}

/** `bracket()` — an OTOCO: one entry, and the two exits that cancel each other. */
export interface BracketOpts {
  readonly entry: EntryOpts;
  readonly takeProfit: TriggerOpts;
  readonly stopLoss: TriggerOpts;
}

/** `positionBracket()` — an OCO over a position that already exists. */
export interface PositionBracketOpts {
  /**
   * The side both legs face — the *closing* side, so `sell` for a long.
   *
   * Required: an OCO has no parent to infer it from, and guessing it wrong doubles a position
   * instead of closing it.
   */
  readonly side: Side;
  readonly takeProfit: TriggerOpts;
  readonly stopLoss: TriggerOpts;
}

/** `oto()` — one order that, when it fills, arms exactly one other. */
export interface OtoOpts {
  readonly entry: EntryOpts;
  /** Which family the armed exit belongs to. No default: a stop and a target are not the same order. */
  readonly exitFamily: TriggerFamily;
  readonly exit: TriggerOpts;
}

/** A grouping type and its legs, in protocol order, with what each leg resolved to. */
export interface GroupPlan {
  /** `1` OTO, `2` OCO, `3` OTOCO. */
  readonly groupingType: number;
  /** Parent first, then stop-loss, then take-profit. **Never reordered downstream.** */
  readonly orders: readonly OrderInfo[];
  /** One entry per leg, in the same order. */
  readonly applied: readonly Applied[];
}

/* ---------------------------------------------------------------------------------------------- */
/* Leg construction                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

/** One resolved leg: the wire shape, and the integers it resolved to. */
export interface Leg {
  readonly order: OrderInfo;
  readonly applied: Applied;
}

/** Assemble an `OrderInfo` from integers that have already been range-checked. */
function toLeg(
  market: MarketInfo,
  o: {
    readonly clientOrderIndex: bigint;
    readonly baseAmount: bigint;
    readonly price: bigint;
    readonly isAsk: boolean;
    readonly type: number;
    readonly timeInForce: number;
    readonly reduceOnly: boolean;
    readonly triggerPrice: bigint;
    readonly orderExpiry: bigint;
  },
): Leg {
  const order: OrderInfo = {
    marketIndex: i16(market.marketId),
    clientOrderIndex: i64(o.clientOrderIndex),
    baseAmount: i64(o.baseAmount),
    price: u32(narrowToU32(o.price, "Price")),
    isAsk: u8(o.isAsk ? 1 : 0),
    type: u8(o.type),
    timeInForce: u8(o.timeInForce),
    reduceOnly: u8(o.reduceOnly ? 1 : 0),
    triggerPrice: u32(narrowToU32(o.triggerPrice, "TriggerPrice")),
    orderExpiry: i64(o.orderExpiry),
  };
  return {
    order,
    applied: {
      baseAmount: o.baseAmount,
      price: o.price,
      triggerPrice: o.triggerPrice,
      orderExpiry: o.orderExpiry,
    },
  };
}

/**
 * The parent leg of an OTO or an OTOCO.
 *
 * A MARKET parent is forced to IOC with a nil expiry, which is both what a market order means and
 * what the validator requires; a LIMIT parent defaults to GTT, whose expiry is non-nil by
 * definition.
 */
export function entryLeg(market: MarketInfo, o: EntryOpts, now: () => number): Leg {
  const isAsk: boolean = isAskOf(o.side);
  const isMarket: boolean = o.market === true;
  if (isMarket && o.timeInForce !== undefined && o.timeInForce !== "IOC") {
    throw new LighterValidationError(
      "ORDER_TIF_INVALID",
      "a MARKET order is immediate-or-cancel; it cannot carry another time in force",
      { field: "TimeInForce" },
    );
  }
  if (isMarket && o.expiry !== undefined && o.expiry !== NIL_ORDER_EXPIRY) {
    // Refused rather than ignored: a caller who passed an expiry believes it applies, and a market
    // order that silently dropped it would look like it had one until the fill said otherwise.
    throw new LighterValidationError(
      "ORDER_EXPIRY_INVALID",
      "a MARKET order carries NilOrderExpiry; it fills or cancels immediately, so there is nothing " +
        "for an expiry to bound",
      { field: "OrderExpiry" },
    );
  }
  const tif: number = isMarket
    ? OrderTimeInForce.ImmediateOrCancel
    : timeInForceOf(o.timeInForce, OrderTimeInForce.GoodTillTime);
  return toLeg(market, {
    clientOrderIndex: clientOrderIndexOf(o.clientOrderId),
    baseAmount: baseAmountOf(market, o.size),
    price: priceOf(market, o.price, isAsk, o.rounding ?? "exact"),
    isAsk,
    type: isMarket ? OrderType.Market : OrderType.Limit,
    timeInForce: tif,
    reduceOnly: o.reduceOnly === true,
    // `NilOrderTriggerPrice`, as a bigint: the wire field is a `uint32`, and every value this
    // module carries between its own functions is a bigint until the branded constructor narrows it.
    triggerPrice: 0n,
    orderExpiry: isMarket ? NIL_ORDER_EXPIRY : expiryFor(tif, o.expiry, now),
  });
}

/**
 * A stop-loss or take-profit leg.
 *
 * `family` and `o.limit` together select the order type. The market variants **must** be IOC; the
 * `*_LIMIT` variants carry no time-in-force constraint at all (`spec/04-tx-types.md` §8.4), which is
 * why the default differs between them. All four require a non-nil trigger and a non-nil expiry, so
 * the expiry default is applied even to an IOC leg — the one place `IOC ⇒ nil expiry` does not hold.
 */
export function triggerLeg(
  market: MarketInfo,
  o: TriggerOpts,
  family: TriggerFamily,
  side: Side,
  now: () => number,
): Leg {
  if (o.side !== undefined && o.side !== side) {
    throw new LighterValidationError(
      "IS_ASK_INVALID",
      `this ${family === "stopLoss" ? "stop-loss" : "take-profit"} leg must be a ${side}; ` +
        `${JSON.stringify(o.side)} would face the wrong way for the position it protects`,
      { field: "IsAsk" },
    );
  }
  const isAsk: boolean = isAskOf(side);
  const isLimit: boolean = o.limit === true;
  if (!isLimit && o.timeInForce !== undefined && o.timeInForce !== "IOC") {
    throw new LighterValidationError(
      "ORDER_TIF_INVALID",
      "a STOP_LOSS / TAKE_PROFIT order must be immediate-or-cancel; pass `limit: true` for the " +
        "STOP_LOSS_LIMIT / TAKE_PROFIT_LIMIT variant, whose time in force is unconstrained",
      { field: "TimeInForce" },
    );
  }
  const type: number = isLimit
    ? family === "stopLoss"
      ? OrderType.StopLossLimit
      : OrderType.TakeProfitLimit
    : family === "stopLoss"
      ? OrderType.StopLoss
      : OrderType.TakeProfit;
  const tif: number = isLimit
    ? timeInForceOf(o.timeInForce, OrderTimeInForce.GoodTillTime)
    : OrderTimeInForce.ImmediateOrCancel;
  const rounding: PriceRounding = o.rounding ?? "exact";
  return toLeg(market, {
    clientOrderIndex: clientOrderIndexOf(o.clientOrderId),
    baseAmount: baseAmountOf(market, o.size),
    price: priceOf(market, o.price, isAsk, rounding),
    isAsk,
    type,
    timeInForce: tif,
    // A nil size is legal only on a reduce-only order, and a position-tied exit is exactly that.
    reduceOnly: o.reduceOnly ?? o.size === undefined,
    triggerPrice: triggerOf(market, o.triggerPrice, isAsk, rounding),
    // Non-nil whatever the time in force, so the default comes from GTT's rule rather than `tif`.
    orderExpiry: expiryFor(OrderTimeInForce.GoodTillTime, o.expiry, now),
  });
}

/* ---------------------------------------------------------------------------------------------- */
/* The three groupings                                                                              */
/* ---------------------------------------------------------------------------------------------- */

/** OTO: one entry and one exit, armed when it fills. The exit faces the other way and is nil-sized. */
export function buildOto(market: MarketInfo, o: OtoOpts, now: () => number): GroupPlan {
  const shared: () => number = frozenClock(now);
  const parent: Leg = entryLeg(market, o.entry, shared);
  const child: Leg = triggerLeg(market, o.exit, o.exitFamily, opposite(o.entry.side), shared);
  return plan(market, GroupingType.OneTriggersTheOther, [parent, child]);
}

/**
 * OCO: two exits over a position that already exists.
 *
 * Both legs face the closing side, both are reduce-only, both are nil-sized by default — which is
 * what makes them position-tied — and their expiries must be **identical**, so one clock reading is
 * shared across both.
 */
export function buildOco(
  market: MarketInfo,
  o: PositionBracketOpts,
  now: () => number,
): GroupPlan {
  const shared: () => number = frozenClock(now);
  const stopLoss: Leg = triggerLeg(market, o.stopLoss, "stopLoss", o.side, shared);
  const takeProfit: Leg = triggerLeg(market, o.takeProfit, "takeProfit", o.side, shared);
  return plan(market, GroupingType.OneCancelsTheOther, [stopLoss, takeProfit]);
}

/** OTOCO: an entry, and the OCO pair armed when it fills. Both children oppose the parent. */
export function buildOtoco(market: MarketInfo, o: BracketOpts, now: () => number): GroupPlan {
  const shared: () => number = frozenClock(now);
  const parent: Leg = entryLeg(market, o.entry, shared);
  const exitSide: Side = opposite(o.entry.side);
  const stopLoss: Leg = triggerLeg(market, o.stopLoss, "stopLoss", exitSide, shared);
  const takeProfit: Leg = triggerLeg(market, o.takeProfit, "takeProfit", exitSide, shared);
  return plan(market, GroupingType.OneTriggersAOneCancelsTheOther, [parent, stopLoss, takeProfit]);
}

/**
 * One clock reading, reused by every leg of a group.
 *
 * Two `Date.now()` calls a millisecond apart produce two different default expiries, and OCO
 * requires them to be *identical*. Freezing the reading is the difference between a group that
 * validates and one that fails on a millisecond boundary, intermittently.
 */
function frozenClock(now: () => number): () => number {
  const at: number = Math.trunc(now());
  return (): number => at;
}

/** Assemble the plan and refuse it here, before anything is signed. */
function plan(market: MarketInfo, groupingType: number, legs: readonly Leg[]): GroupPlan {
  const orders: readonly OrderInfo[] = legs.map((l: Leg): OrderInfo => l.order);
  assertGroupLegality(market, groupingType, orders);
  return {
    groupingType,
    orders,
    applied: legs.map((l: Leg): Applied => l.applied),
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Legality                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Refuse an illegal group **locally, before any I/O and before anything is signed**.
 *
 * Two checks, in this order:
 *
 * 1. **The registry's opinion of the market.** Grouped orders are perps-only. The transaction
 *    validator can only test the index *range*, and while spot indices do sit outside the perps
 *    window today, that is a protocol constant which could widen; the registry knows what the
 *    market actually is, so it is asked first and its refusal names the market.
 * 2. **The reference's own table**, by handing a probe transaction to
 *    `validateCreateGroupedOrders`. Leg count, per-leg core rules, client-order-index uniqueness,
 *    the parent/child type sets, and the per-grouping size / side / reduce-only / expiry rules all
 *    come from there rather than from a second copy here. The probe carries a zero identity because
 *    no rule this function asks about reads one, and the real transaction is validated again by its
 *    builder a moment later with the identity it will actually be signed with.
 *
 * @throws {LighterValidationError} the `spec/04-tx-types.md` §12 code of the first violated rule.
 */
export function assertGroupLegality(
  market: MarketInfo,
  groupingType: number,
  orders: readonly OrderInfo[],
): void {
  if (market.marketType !== "perp") {
    throw new LighterValidationError(
      "MARKET_INDEX_NOT_PERPS",
      `grouped orders are perps-only; ${market.symbol} (market ${String(market.marketId)}) is a ` +
        `${market.marketType} market`,
      { field: "MarketIndex", txType: TxType.L2CreateGroupedOrders },
    );
  }
  const probe: CreateGroupedOrdersTx = {
    type: TxType.L2CreateGroupedOrders,
    accountIndex: i64(0n),
    apiKeyIndex: u8(0),
    nonce: i64(0n),
    expiredAt: i64(0n),
    groupingType: u8(groupingType),
    orders,
  };
  validateCreateGroupedOrders(probe, { strict: true });
}
