/**
 * The order book, as an immutable snapshot, and the two exact readings taken from it: the best
 * price and the average price a given order would achieve by walking the opposing side.
 *
 * Everything here is a **pure function over a snapshot**. Nothing in this file performs I/O, reads
 * a clock, holds module state or mutates its arguments. That is deliberate and it is the one
 * structural fix this module makes to the reference: `lighter-python` implements both readings as
 * methods that go and get the book themselves, so neither can be reused against a book maintained
 * over the WebSocket, and neither can be tested without a server. Here the same function serves
 * `GET /api/v1/orderBookOrders`, `OrderBookState` from `src/ws/orderbook.ts`, and a hand-written
 * fixture (`docs/spec/07-high-level-client.md` §3.4).
 *
 * ## Two things the wire gets wrong that this file refuses to inherit
 *
 * 1. **Prices are not decimal points to be deleted.** The reference turns `"4050.00"` into `405000`
 *    by removing the `.`, which is right only while the server happens to pad every string to the
 *    market's declared price precision. `"4050"` would become `4050` and `"4050.0"` would become
 *    `40500` — a 100× and a 10× price error, silently (`docs/protocol-notes.md` §9, hazard 3).
 *    Here every string is scaled by the market's declared precision through
 *    `src/util/decimal.ts`, so all three spellings of the same price agree, and a string carrying
 *    *more* information than the market's precision can express is rejected rather than truncated.
 * 2. **`bids[0]` is not necessarily the best bid.** The reference WebSocket client appends new
 *    price levels to the end of its arrays, so its book stops being sorted after the first update
 *    (`docs/protocol-notes.md` §10.2). A walk down a mis-sorted book returns a plausible,
 *    wrong average price. So ordering is asserted on ingest *and* again on every read: bids must
 *    descend strictly, asks must ascend strictly, and a duplicate price is a fold that did not
 *    happen.
 *
 * ## Exactness
 *
 * The walk is stated over integers and rationals and is implemented that way: the average price
 * comes back as a `(num, den)` pair and is never divided out. Only one level in a quote-sized walk
 * can ever be partially consumed — the last one — so the running denominator picks up at most one
 * price factor, and truncating it (which the reference does per level, systematically under-filling)
 * never happens.
 */

import { LighterMathError, LighterValidationError } from "../../errors.js";
import type { OrderBookOrders, SimpleOrder } from "../../models/order.js";
import { toScaled } from "../../util/decimal.js";
import type { MarketInfo } from "../markets.js";

/* -------------------------------------------------------------------------------------------- */
/* Shapes                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * An exact rational.
 *
 * Average prices, slippage fractions and effective leverages all travel as a `(num, den)` pair and
 * are never divided out. `den` is always positive and the pair is always in lowest terms, so two
 * fractions from anywhere in this module can be compared by cross-multiplication without first
 * agreeing on a form.
 */
export interface Fraction {
  readonly num: bigint;
  readonly den: bigint;
}

/**
 * One aggregated price level, scaled by the market's declared precision.
 *
 * `priceScaled` is at `market.priceDecimals` and `sizeScaled` at `market.sizeDecimals`, so
 * `priceScaled × sizeScaled` is a notional at `market.quoteDecimals` exactly when the market
 * satisfies the cross-scale invariant (`MarketInfo.quoteSizingSupported`).
 */
export interface BookLevel {
  readonly priceScaled: bigint;
  readonly sizeScaled: bigint;
}

/**
 * Both sides of an aggregated book at one instant.
 *
 * `bids` descend by price and `asks` ascend, both strictly. A snapshot that violates that is
 * rejected wherever it is read; it is never walked.
 */
export interface BookSnapshot {
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
}

/** The exact average price of a simulated walk, plus how much of the request it covered. */
export interface ExecutionEstimate {
  /** Numerator of the exact average price, at the market's price precision. */
  readonly avgPriceNum: bigint;
  /** Denominator of the exact average price. Always positive, always in lowest terms. */
  readonly avgPriceDen: bigint;
  /**
   * How much of `amount` the visible book absorbed, in the same unit `amount` was given in.
   *
   * `filled < amount` is *not* an error here — it is the caller's `INSUFFICIENT_DEPTH`, and it is a
   * different condition from "the achievable price is worse than the bound".
   */
  readonly filled: bigint;
}

/** Which side a level list is, for ordering assertions and error messages. */
type Side = "bids" | "asks";

/* -------------------------------------------------------------------------------------------- */
/* Ingest                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * Fold `GET /api/v1/orderBookOrders` — **individual resting orders, not levels** — into aggregated
 * levels.
 *
 * Orders at one price are summed, and the result is sorted here rather than trusted from the wire.
 * Sorting is not paranoia about this endpoint (its output was observed sorted); it is that folding
 * requires grouping anyway, so the sort is free and the guarantee is then structural.
 *
 * `remaining_base_amount` is the size that matters — `initial_base_amount` includes what has
 * already traded. A fully-filled order still listed in the response contributes nothing and is
 * dropped; a negative size is malformed and throws.
 *
 * `total_asks` / `total_bids` are the counts *returned*, bounded by the request's `limit`. They are
 * not book totals and nothing here reads them.
 */
export function bookFromRestOrders(resp: OrderBookOrders, market: MarketInfo): BookSnapshot {
  return {
    bids: foldOrders(resp.bids, market, "bids"),
    asks: foldOrders(resp.asks, market, "asks"),
  };
}

/**
 * Adapt already-aggregated levels — a WebSocket-maintained book, a REST depth response, a fixture —
 * into a validated snapshot.
 *
 * The input is deliberately the lowest common denominator, `{ price, size }` decimal strings, which
 * `OrderBookLevel` from `src/ws/orderbook.ts` satisfies structurally. Its own scaled fields are at
 * a fixed 18 decimals and are *not* reused: the scale that matters here is the market's.
 *
 * Unlike {@link bookFromRestOrders} this does **not** sort. Aggregated input claims to be ordered,
 * and silently repairing it would hide exactly the reference defect described at the top of this
 * file, so mis-ordered input throws.
 */
export function bookFromLevels(
  bids: readonly { price: string; size: string }[],
  asks: readonly { price: string; size: string }[],
  market: MarketInfo,
): BookSnapshot {
  const snapshot: BookSnapshot = {
    bids: bids.map((l: { price: string; size: string }): BookLevel => toLevel(l.price, l.size, market, "bids")),
    asks: asks.map((l: { price: string; size: string }): BookLevel => toLevel(l.price, l.size, market, "asks")),
  };
  assertOrdered(snapshot.bids, "bids");
  assertOrdered(snapshot.asks, "asks");
  return snapshot;
}

/* -------------------------------------------------------------------------------------------- */
/* Readings                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * The integer price, at the market's price precision, that an aggressive order would start at.
 *
 * A **buy** (`isAsk === false`) lifts the offer, so it reads `asks[0]`; a **sell**
 * (`isAsk === true`) hits the bid, so it reads `bids[0]` (`docs/spec/07-high-level-client.md`
 * §3.3). The side is verified to be ordered before its head is believed.
 *
 * An empty side is {@link LighterMathError} `NO_LIQUIDITY`. The reference divides by zero.
 */
export function bestPrice(book: BookSnapshot, isAsk: boolean): bigint {
  const side: Side = isAsk ? "bids" : "asks";
  const levels: readonly BookLevel[] = isAsk ? book.bids : book.asks;
  assertOrdered(levels, side);
  const head: BookLevel | undefined = levels[0];
  if (head === undefined) {
    throw new LighterMathError("NO_LIQUIDITY", `the ${side} side of the book is empty`);
  }
  return head.priceScaled;
}

/**
 * Simulate an immediate order against the opposing side and return the exact average price.
 *
 * Selling (`isAsk === true`) consumes `bids`; buying consumes `asks`. `amount` is a base size when
 * `amountIsBase`, otherwise a quote notional, and is always an integer at the corresponding
 * market precision.
 *
 * The walk, from `docs/spec/07-high-level-client.md` §3.4:
 *
 * ```
 * for each level (priceInt, sizeInt), best first:
 *     stop when the matched amount equals the request
 *     capacity = amountIsBase ? amount − matchedBase : (amount − matchedQuote) / priceInt
 *     take     = min(capacity, sizeInt)
 *     matchedQuote += priceInt × take
 *     matchedBase  += take
 * ```
 *
 * `capacity` is a rational in the quote-sized case, and `take` is compared and accumulated without
 * truncation. That matters: rounding `take` down per level under-fills systematically, always in
 * the same direction, and the error compounds with book depth. Note that `matchedQuote` stays an
 * integer on both paths — a partial take is by construction the exact remainder — and that a
 * partial take can only happen on the level the walk stops at, so `matchedBase`'s denominator picks
 * up at most one price factor.
 *
 * Returns the same `(num, den)` representation from both branches. The reference returns an exact
 * rational when sizing by quote and a lossy float when sizing by base
 * (`docs/protocol-notes.md` §9, hazard 4); a caller cannot then reason about its own precision.
 *
 * Throws `NO_LIQUIDITY` when the opposing side is empty. It does **not** throw when the book is
 * merely too thin: that is reported through `filled` so the caller can distinguish it.
 */
export function potentialExecutionPrice(
  book: BookSnapshot,
  amount: bigint,
  isAsk: boolean,
  amountIsBase: boolean,
): ExecutionEstimate {
  if (typeof amount !== "bigint" || amount <= 0n) {
    throw new LighterValidationError(
      "ORDER_AMOUNT_TOO_LOW",
      `amount to walk the book with must be a positive integer, got ${String(amount)}`,
    );
  }
  const side: Side = isAsk ? "bids" : "asks";
  const levels: readonly BookLevel[] = isAsk ? book.bids : book.asks;
  assertOrdered(levels, side);
  if (levels.length === 0) {
    throw new LighterMathError("NO_LIQUIDITY", `the ${side} side of the book is empty`);
  }

  // `matchedQuote` is exact on both paths. `matchedBase` is the rational `baseNum / baseDen`, and
  // `baseDen` stays `1n` for the whole of a base-sized walk.
  let matchedQuote: bigint = 0n;
  let baseNum: bigint = 0n;
  let baseDen: bigint = 1n;

  for (const level of levels) {
    if (amountIsBase ? baseNum >= amount : matchedQuote >= amount) break;

    if (amountIsBase) {
      const capacity: bigint = amount - baseNum;
      const take: bigint = capacity < level.sizeScaled ? capacity : level.sizeScaled;
      matchedQuote += level.priceScaled * take;
      baseNum += take;
      continue;
    }

    const remaining: bigint = amount - matchedQuote;
    const levelQuote: bigint = level.priceScaled * level.sizeScaled;
    if (remaining < levelQuote) {
      // Partial, and therefore final: take exactly `remaining / priceScaled` base.
      // baseNum/baseDen + remaining/price = (baseNum·price + remaining·baseDen) / (baseDen·price)
      baseNum = baseNum * level.priceScaled + remaining * baseDen;
      baseDen = baseDen * level.priceScaled;
      matchedQuote = amount;
    } else {
      matchedQuote += levelQuote;
      baseNum += level.sizeScaled * baseDen;
    }
  }

  if (baseNum <= 0n || matchedQuote <= 0n) {
    throw new LighterMathError("NO_LIQUIDITY", `the ${side} side of the book absorbed nothing`);
  }

  // avgPrice = matchedQuote / matchedBase = matchedQuote / (baseNum / baseDen).
  const reduced: Fraction = reduceFraction(matchedQuote * baseDen, baseNum);
  return {
    avgPriceNum: reduced.num,
    avgPriceDen: reduced.den,
    filled: amountIsBase ? baseNum : matchedQuote,
  };
}

/**
 * `num / den` in lowest terms, with the sign carried by the numerator.
 *
 * Exported because the average price crosses module boundaries as a pair and both sides of a
 * comparison have to agree on its canonical form.
 */
export function reduceFraction(num: bigint, den: bigint): Fraction {
  if (den === 0n) {
    throw new LighterValidationError("DIVISION_BY_ZERO", "a fraction denominator cannot be zero");
  }
  const negative: boolean = den < 0n;
  const n: bigint = negative ? -num : num;
  const d: bigint = negative ? -den : den;
  const g: bigint = gcd(n < 0n ? -n : n, d);
  return g === 0n ? { num: 0n, den: 1n } : { num: n / g, den: d / g };
}

/* -------------------------------------------------------------------------------------------- */
/* Internals                                                                                     */
/* -------------------------------------------------------------------------------------------- */

function gcd(a: bigint, b: bigint): bigint {
  let x: bigint = a;
  let y: bigint = b;
  while (y !== 0n) {
    const t: bigint = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** Sum the orders at each price, drop the ones with nothing left, and sort into book order. */
function foldOrders(
  orders: readonly SimpleOrder[] | undefined,
  market: MarketInfo,
  side: Side,
): readonly BookLevel[] {
  if (orders === undefined) return [];
  const byPrice: Map<bigint, bigint> = new Map<bigint, bigint>();
  for (const order of orders) {
    if (order.price === undefined || order.remaining_base_amount === undefined) {
      throw new LighterValidationError(
        "ORDER_BOOK_MALFORMED",
        `a resting order on the ${side} side has no price or no remaining size`,
      );
    }
    const priceScaled: bigint = scaleField(order.price, market.priceDecimals, "price", side);
    const sizeScaled: bigint = scaleField(
      order.remaining_base_amount,
      market.sizeDecimals,
      "remaining_base_amount",
      side,
    );
    if (priceScaled <= 0n) {
      throw new LighterValidationError(
        "ORDER_BOOK_MALFORMED",
        `a resting order on the ${side} side is priced at ${order.price}`,
      );
    }
    if (sizeScaled < 0n) {
      throw new LighterValidationError(
        "ORDER_BOOK_MALFORMED",
        `a resting order on the ${side} side has a negative remaining size (${order.remaining_base_amount})`,
      );
    }
    if (sizeScaled === 0n) continue; // fully filled but still listed: contributes no depth
    byPrice.set(priceScaled, (byPrice.get(priceScaled) ?? 0n) + sizeScaled);
  }

  const levels: BookLevel[] = [];
  for (const [priceScaled, sizeScaled] of byPrice) levels.push({ priceScaled, sizeScaled });
  levels.sort((a: BookLevel, b: BookLevel): number => {
    if (a.priceScaled === b.priceScaled) return 0;
    const aFirst: boolean = side === "bids" ? a.priceScaled > b.priceScaled : a.priceScaled < b.priceScaled;
    return aFirst ? -1 : 1;
  });
  return levels;
}

/** One aggregated `{ price, size }` pair, scaled and range-checked. */
function toLevel(price: string, size: string, market: MarketInfo, side: Side): BookLevel {
  const priceScaled: bigint = scaleField(price, market.priceDecimals, "price", side);
  const sizeScaled: bigint = scaleField(size, market.sizeDecimals, "size", side);
  if (priceScaled <= 0n) {
    throw new LighterValidationError("ORDER_BOOK_MALFORMED", `a ${side} level is priced at ${price}`);
  }
  if (sizeScaled <= 0n) {
    // Zero is a tombstone in the delta protocol, never a level; seeing one here means a book was
    // materialised without applying its own removals.
    throw new LighterValidationError("ORDER_BOOK_MALFORMED", `a ${side} level has size ${size}`);
  }
  return { priceScaled, sizeScaled };
}

/**
 * Scale one wire string by the market's declared precision.
 *
 * `EXACT` is the whole point. `"4050"`, `"4050.0"` and `"4050.00"` are one price and all three
 * scale identically; `"4050.001"` at two declared decimals carries information the market cannot
 * represent, and is a symptom of the wrong market being applied to the book, so it is rejected
 * rather than rounded away.
 */
function scaleField(value: string, decimals: number, field: string, side: Side): bigint {
  try {
    return toScaled(value, decimals, "EXACT");
  } catch (cause: unknown) {
    throw new LighterValidationError(
      "ORDER_BOOK_MALFORMED",
      `${side}: \`${field}\` ${JSON.stringify(value)} is not representable at ${String(decimals)} decimals`,
      { cause, field },
    );
  }
}

/** Bids strictly descend, asks strictly ascend. Equal adjacent prices mean an unfolded book. */
function assertOrdered(levels: readonly BookLevel[], side: Side): void {
  for (let i: number = 1; i < levels.length; i++) {
    const previous: BookLevel | undefined = levels[i - 1];
    const current: BookLevel | undefined = levels[i];
    if (previous === undefined || current === undefined) continue;
    const ok: boolean =
      side === "bids"
        ? previous.priceScaled > current.priceScaled
        : previous.priceScaled < current.priceScaled;
    if (!ok) {
      throw new LighterValidationError(
        "ORDER_BOOK_UNSORTED",
        `${side} must be strictly ${side === "bids" ? "descending" : "ascending"}: ` +
          `${previous.priceScaled.toString()} then ${current.priceScaled.toString()} at index ${String(i)}`,
      );
    }
  }
}
