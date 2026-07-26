/**
 * Sizing a market order: "spend 8.2 USDC" and "sell 0.1 ETH, but only if I get a decent price"
 * turned into the exact integers a `create_order` transaction carries.
 *
 * Both entry points here are gates as much as they are conversions. They walk the book, compare the
 * achievable average price against the slippage bound, and refuse — loudly, with a distinguishable
 * code — rather than emit an order that will fill at a price the caller did not agree to:
 *
 * | Condition | Code |
 * | --- | --- |
 * | the opposing side is empty | `NO_LIQUIDITY` |
 * | the visible book cannot absorb the request at any price | `INSUFFICIENT_DEPTH` |
 * | it can, but not within the bound | `EXCESSIVE_SLIPPAGE` |
 * | the market cannot express quote sizing at all | `SCALE_INVARIANT_VIOLATED` |
 *
 * The last one is not defensive programming. `baseInt = quoteInt / avgPrice` is dimensionally
 * correct only when `priceDecimals + sizeDecimals === quoteDecimals`, which
 * `MarketInfo.quoteSizingSupported` records at metadata load. Where it does not hold, the answer is
 * wrong by a power of ten — an order a hundred times too large is not a rounding error — so this
 * module refuses the market instead of computing (`docs/spec/07-high-level-client.md` §3.6).
 *
 * Two orderings are deliberate and both are load-bearing:
 *
 * 1. **Slippage is checked before depth**, per §3.6 steps 5 and 6. A thin book that would also
 *    breach the bound reports the price problem, which is the one the caller can act on by widening
 *    the bound or waiting.
 * 2. **The comparison is always against the *rounded* bound**, on both the quote-sized and the
 *    base-sized path. The reference rounds after comparing on one path and before it on the other,
 *    so the two disagree at the boundary tick; here the exact rational average is compared against
 *    the integer the order will actually carry, which is the number that decides the fill.
 *
 * The requested notional is parsed lexically and floored, so a caller asking to spend `"8.2"` at six
 * decimals gets exactly `8_200_000`. The reference computes that product in binary floating point
 * and truncates, yielding `8_199_999` — silently, systematically, and always downward
 * (`docs/protocol-notes.md` §9, hazard 2).
 */

import { LighterMathError, LighterValidationError } from "../../errors.js";
import { divRound, toScaled } from "../../util/decimal.js";
import type { MarketInfo } from "../markets.js";
import {
  bestPrice,
  type BookSnapshot,
  type ExecutionEstimate,
  type Fraction,
  potentialExecutionPrice,
} from "./book.js";
import { slippageBound, type SlippageMode } from "./slippage.js";

/* -------------------------------------------------------------------------------------------- */
/* Shapes                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** `MinOrderBaseAmount`. `0` is `NilOrderBaseAmount`, i.e. "the whole position". */
export const MIN_ORDER_BASE_AMOUNT: bigint = 1n;

/** `MaxOrderBaseAmount`. */
export const MAX_ORDER_BASE_AMOUNT: bigint = 2n ** 48n - 1n;

/** Overrides shared by both sizing paths. */
export interface SizingOptions {
  /**
   * The price the slippage bound is measured from, when the caller has a better one than the top of
   * this snapshot — a mark price, a mid, a price from a fresher book.
   */
  readonly idealPrice?: bigint;
  /** Rounding policy for the bound. `conservative` unless the caller says otherwise. */
  readonly mode?: SlippageMode;
}

/** A quote-sized market order, resolved to protocol integers. */
export interface QuoteSizing {
  /** `base_amount`, at the market's size precision. */
  readonly baseAmount: bigint;
  /** `price`, at the market's price precision: the slippage bound the order is capped at. */
  readonly price: bigint;
  /** Numerator of the exact average price the walk achieved. */
  readonly avgPriceNum: bigint;
  /** Denominator of the exact average price. */
  readonly avgPriceDen: bigint;
}

/** A base-sized market order that passed the slippage and depth gates. */
export interface BaseSizing {
  /** `price`, at the market's price precision: the slippage bound the order is capped at. */
  readonly price: bigint;
  /** Numerator of the exact average price the walk achieved. Same representation as {@link QuoteSizing}. */
  readonly avgPriceNum: bigint;
  /** Denominator of the exact average price. */
  readonly avgPriceDen: bigint;
  /** Base absorbed by the walk. Equal to the requested size, or the call would have been rejected. */
  readonly filled: bigint;
}

/* -------------------------------------------------------------------------------------------- */
/* Quote-sized                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * Convert a quote notional into a base size, gated on slippage and depth.
 *
 * `quote` is a decimal string in quote units (`"8.2"` USDC), `maxSlippage` is `"0.005"`, `"0.5%"` or
 * `"50bps"`, and `isAsk` describes the order — `true` sells base for quote, `false` buys base with
 * quote. The steps are `docs/spec/07-high-level-client.md` §3.6, in order.
 *
 * The returned `baseAmount` is `floor(quoteInt / avgPrice)` computed as exact rational division, so
 * the notional it implies is never above the notional that was asked for. Rounding down is the
 * whole safety property: rounding up spends money the caller did not offer.
 */
export function quoteToBase(
  book: BookSnapshot,
  market: MarketInfo,
  quote: string,
  isAsk: boolean,
  maxSlippage: string | Fraction,
  options?: SizingOptions,
): QuoteSizing {
  if (market.quoteSizingSupported !== true) {
    throw new LighterMathError(
      "SCALE_INVARIANT_VIOLATED",
      `${market.symbol} declares price ${String(market.priceDecimals)} + size ${String(market.sizeDecimals)} ` +
        `decimals against a quote precision of ${String(market.quoteDecimals)}; a quote-sized order on this ` +
        `market would be wrong by a power of ten, so it is refused rather than computed`,
    );
  }

  // 1. Lexical, floored: never spend more than was offered, and never route through a float.
  const quoteInt: bigint = toScaled(quote, market.quoteDecimals, "FLOOR");
  if (quoteInt <= 0n) {
    throw new LighterValidationError(
      "QUOTE_AMOUNT_TOO_LOW",
      `a quote amount of ${JSON.stringify(quote)} is not a positive notional at ` +
        `${String(market.quoteDecimals)} decimals`,
    );
  }

  // 2-3. The bound, from the caller's ideal price or the top of the book.
  const price: bigint = boundFor(book, isAsk, maxSlippage, options);

  // 4-6. Walk, then gate: price first, depth second.
  const estimate: ExecutionEstimate = potentialExecutionPrice(book, quoteInt, isAsk, false);
  assertWithinBound(estimate, price, isAsk);
  assertFilled(estimate.filled, quoteInt, "quote");

  // 7. Exact rational division: baseInt = floor(quoteInt × avgPriceDen / avgPriceNum).
  const baseAmount: bigint = divRound(quoteInt * estimate.avgPriceDen, estimate.avgPriceNum, "FLOOR");

  // 8. Pre-flight against the market's own limits before anything is signed.
  assertBaseWithinLimits(baseAmount, market);
  assertNotionalWithinLimits(notionalOf(baseAmount, estimate), quoteInt, market);

  return {
    baseAmount,
    price,
    avgPriceNum: estimate.avgPriceNum,
    avgPriceDen: estimate.avgPriceDen,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Base-sized                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * The gate behind `create_market_order_if_slippage`: walk the book for a base size already decided,
 * reject if the achievable average is worse than the bound or the book is too thin, and otherwise
 * return the capped price to submit at.
 *
 * `baseAmount` is an integer at the market's size precision. The average price comes back in the
 * same `(num, den)` representation {@link quoteToBase} returns — the reference hands back an exact
 * rational from one path and a float from the other, which makes the two impossible to compare
 * (`docs/protocol-notes.md` §9, hazard 4).
 *
 * The notional limits are only checked on a market whose scales permit a notional to be computed at
 * all; the base-size limits always are.
 */
export function baseOrderIfSlippage(
  book: BookSnapshot,
  market: MarketInfo,
  baseAmount: bigint,
  isAsk: boolean,
  maxSlippage: string | Fraction,
  options?: SizingOptions,
): BaseSizing {
  assertBaseWithinLimits(baseAmount, market);
  const price: bigint = boundFor(book, isAsk, maxSlippage, options);
  const estimate: ExecutionEstimate = potentialExecutionPrice(book, baseAmount, isAsk, true);
  assertWithinBound(estimate, price, isAsk);
  assertFilled(estimate.filled, baseAmount, "base");

  if (market.quoteSizingSupported === true) {
    const notional: bigint = notionalOf(baseAmount, estimate);
    assertNotionalWithinLimits(notional, notional, market);
  }

  return {
    price,
    avgPriceNum: estimate.avgPriceNum,
    avgPriceDen: estimate.avgPriceDen,
    filled: estimate.filled,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Internals                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** The slippage bound, measured from the caller's ideal price or the top of the opposing side. */
function boundFor(
  book: BookSnapshot,
  isAsk: boolean,
  maxSlippage: string | Fraction,
  options: SizingOptions | undefined,
): bigint {
  const ideal: bigint = options?.idealPrice ?? bestPrice(book, isAsk);
  return slippageBound(ideal, maxSlippage, isAsk, options?.mode ?? "conservative");
}

/**
 * Compare the exact rational average against the rounded bound.
 *
 * A buy is rejected when the average is *above* its ceiling, a sell when it is *below* its floor.
 * Cross-multiplied, never divided: `avgPriceDen` is positive by construction, so the inequality
 * direction is preserved.
 */
function assertWithinBound(estimate: ExecutionEstimate, bound: bigint, isAsk: boolean): void {
  const scaledBound: bigint = bound * estimate.avgPriceDen;
  const breached: boolean = isAsk ? estimate.avgPriceNum < scaledBound : estimate.avgPriceNum > scaledBound;
  if (!breached) return;
  throw new LighterMathError(
    "EXCESSIVE_SLIPPAGE",
    `the book fills a ${isAsk ? "sell" : "buy"} at an average of ` +
      `${estimate.avgPriceNum.toString()}/${estimate.avgPriceDen.toString()}, ` +
      `${isAsk ? "below" : "above"} the acceptable price of ${bound.toString()}`,
  );
}

/** `filled < requested` is depth, not price, and the caller has to be able to tell them apart. */
function assertFilled(filled: bigint, requested: bigint, unit: "base" | "quote"): void {
  if (filled >= requested) return;
  throw new LighterMathError(
    "INSUFFICIENT_DEPTH",
    `the visible book absorbs ${filled.toString()} of ${requested.toString()} ${unit} units at any price`,
  );
}

/** The notional actually implied by a base size at the achieved average price, floored. */
function notionalOf(baseAmount: bigint, estimate: ExecutionEstimate): bigint {
  return divRound(baseAmount * estimate.avgPriceNum, estimate.avgPriceDen, "FLOOR");
}

/** `base_amount` against the protocol domain and the market's own minimum. */
function assertBaseWithinLimits(baseAmount: bigint, market: MarketInfo): void {
  if (typeof baseAmount !== "bigint" || baseAmount < MIN_ORDER_BASE_AMOUNT) {
    throw new LighterValidationError(
      "BASE_AMOUNT_TOO_LOW",
      `base amount ${String(baseAmount)} is below MinOrderBaseAmount; a zero base amount is ` +
        `NilOrderBaseAmount, which means "the whole position" rather than "nothing"`,
      { bound: MIN_ORDER_BASE_AMOUNT, field: "BaseAmount" },
    );
  }
  if (baseAmount > MAX_ORDER_BASE_AMOUNT) {
    throw new LighterValidationError(
      "BASE_AMOUNT_TOO_HIGH",
      `base amount ${baseAmount.toString()} exceeds MaxOrderBaseAmount`,
      { bound: MAX_ORDER_BASE_AMOUNT, field: "BaseAmount" },
    );
  }
  // The market's minimum is rounded up, so a market that publishes more precision than it declares
  // can only make the gate stricter.
  const minimum: bigint = toScaled(market.minBaseAmount, market.sizeDecimals, "CEIL");
  if (baseAmount < minimum) {
    throw new LighterValidationError(
      "BASE_AMOUNT_TOO_LOW",
      `base amount ${baseAmount.toString()} is below ${market.symbol}'s minimum of ` +
        `${market.minBaseAmount} (${minimum.toString()})`,
      { bound: minimum, field: "BaseAmount" },
    );
  }
}

/**
 * The notional against the market's floor and ceiling.
 *
 * `achieved` is what the order is expected to be worth and is tested against the minimum;
 * `requested` is what the caller asked to commit and is tested against the ceiling. They differ
 * only by the flooring in step 7, and taking the conservative one at each end means neither bound
 * can be slipped past by a rounding step.
 */
function assertNotionalWithinLimits(achieved: bigint, requested: bigint, market: MarketInfo): void {
  const minimum: bigint = toScaled(market.minQuoteAmount, market.quoteDecimals, "CEIL");
  if (minimum > 0n && achieved < minimum) {
    throw new LighterValidationError(
      "QUOTE_AMOUNT_TOO_LOW",
      `a notional of ${achieved.toString()} is below ${market.symbol}'s minimum of ` +
        `${market.minQuoteAmount} (${minimum.toString()})`,
      { bound: minimum },
    );
  }
  const limit: bigint = toScaled(market.orderQuoteLimit, market.quoteDecimals, "FLOOR");
  if (limit > 0n && requested > limit) {
    throw new LighterValidationError(
      "QUOTE_AMOUNT_TOO_HIGH",
      `a notional of ${requested.toString()} exceeds ${market.symbol}'s per-order limit of ` +
        `${market.orderQuoteLimit} (${limit.toString()})`,
      { bound: limit },
    );
  }
}
