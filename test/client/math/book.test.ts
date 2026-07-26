/**
 * The book: ingest, ordering, and the exact walk.
 *
 * The aggregation cases run against the captured `orderBookOrders` body, which happens to contain
 * two resting bids at the same price — the fold this endpoint requires is therefore exercised by
 * real bytes rather than by a constructed example.
 */

import { describe, expect, test } from "bun:test";

import {
  bestPrice,
  type BookLevel,
  bookFromLevels,
  bookFromRestOrders,
  type BookSnapshot,
  type ExecutionEstimate,
  potentialExecutionPrice,
  reduceFraction,
} from "../../../src/client/math/book.js";
import type { MarketInfo } from "../../../src/client/markets.js";
import { LighterMathError, LighterValidationError } from "../../../src/errors.js";
import type { OrderBookOrders } from "../../../src/models/order.js";
import { btcMarket, caught, diaMarket, goldenOrderBookOrders, thrownCode } from "./fixtures.js";

/* ---------------------------------------------------------------------------------------------- */
/* Ingest                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

describe("bookFromRestOrders", () => {
  test("folds the captured resting orders into aggregated levels", () => {
    const book: BookSnapshot = bookFromRestOrders(goldenOrderBookOrders(), btcMarket());

    // Prices at one decimal, sizes at five: "64504.2" -> 645042, "0.17551" -> 17551.
    expect(book.asks).toEqual([
      { priceScaled: 645042n, sizeScaled: 17551n },
      { priceScaled: 645062n, sizeScaled: 77n },
      { priceScaled: 645064n, sizeScaled: 18000n },
    ]);

    // The capture carries two separate resting orders at 64500.0; they are one level.
    expect(book.bids).toEqual([
      { priceScaled: 645001n, sizeScaled: 2613n },
      { priceScaled: 645000n, sizeScaled: 3336n + 7437n },
    ]);
  });

  test("sorts rather than trusting the wire's order", () => {
    const scrambled: OrderBookOrders = {
      code: 200,
      bids: [
        { price: "100.0", remaining_base_amount: "1.00000" },
        { price: "101.0", remaining_base_amount: "2.00000" },
      ],
      asks: [
        { price: "103.0", remaining_base_amount: "1.00000" },
        { price: "102.0", remaining_base_amount: "1.00000" },
      ],
    };
    const book: BookSnapshot = bookFromRestOrders(scrambled, btcMarket());
    expect(book.bids.map((l: BookLevel): bigint => l.priceScaled)).toEqual([1010n, 1000n]);
    expect(book.asks.map((l: BookLevel): bigint => l.priceScaled)).toEqual([1020n, 1030n]);
  });

  test("drops a fully-filled order and rejects a negative remainder", () => {
    const withZero: OrderBookOrders = {
      code: 200,
      asks: [
        { price: "100.0", remaining_base_amount: "0.00000" },
        { price: "101.0", remaining_base_amount: "1.00000" },
      ],
    };
    expect(bookFromRestOrders(withZero, btcMarket()).asks).toEqual([{ priceScaled: 1010n, sizeScaled: 100000n }]);

    const negative: OrderBookOrders = {
      code: 200,
      asks: [{ price: "100.0", remaining_base_amount: "-1.00000" }],
    };
    expect(caught((): unknown => bookFromRestOrders(negative, btcMarket()))).toBeInstanceOf(
      LighterValidationError,
    );
  });

  test("a missing price or size is malformed, not empty", () => {
    expect(thrownCode((): unknown => bookFromRestOrders({ code: 200, asks: [{ price: "100.0" }] }, btcMarket()))).toBe(
      "ORDER_BOOK_MALFORMED",
    );
  });
});

describe("bookFromLevels", () => {
  test("all spellings of one price agree, and zero has several spellings", () => {
    const market: MarketInfo = diaMarket(); // price 2 dp, size 4 dp
    const a: BookSnapshot = bookFromLevels([], [{ price: "2064.54", size: "1.0" }], market);
    const b: BookSnapshot = bookFromLevels([], [{ price: "2064.5400", size: "1.0000" }], market);
    expect(a).toEqual(b);
    expect(a.asks[0]?.priceScaled).toBe(206454n);
  });

  test("bids ascending throws rather than being silently walked", () => {
    const market: MarketInfo = diaMarket();
    const ascendingBids: readonly { price: string; size: string }[] = [
      { price: "100.00", size: "1.0000" },
      { price: "101.00", size: "1.0000" },
    ];
    expect(thrownCode((): unknown => bookFromLevels(ascendingBids, [], market))).toBe("ORDER_BOOK_UNSORTED");
  });

  test("asks descending throws, and so does a repeated price", () => {
    const market: MarketInfo = diaMarket();
    expect(
      thrownCode((): unknown =>
        bookFromLevels(
          [],
          [
            { price: "101.00", size: "1.0000" },
            { price: "100.00", size: "1.0000" },
          ],
          market,
        ),
      ),
    ).toBe("ORDER_BOOK_UNSORTED");
    expect(
      thrownCode((): unknown =>
        bookFromLevels(
          [],
          [
            { price: "100.00", size: "1.0000" },
            { price: "100.0000", size: "1.0000" },
          ],
          market,
        ),
      ),
    ).toBe("ORDER_BOOK_UNSORTED");
  });

  test("an aggregated level with zero size is a tombstone that leaked", () => {
    expect(
      thrownCode((): unknown => bookFromLevels([], [{ price: "100.00", size: "0.0000" }], diaMarket())),
    ).toBe("ORDER_BOOK_MALFORMED");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Hazard 3 — the decimal point is not a separator to be deleted                                    */
/* ---------------------------------------------------------------------------------------------- */

describe("hazard 3: int(price.replace('.', '')) is correct only by accident", () => {
  test("'4050', '4050.0' and '4050.00' are one price at 2 declared decimals", () => {
    const market: MarketInfo = diaMarket(); // priceDecimals = 2
    for (const spelling of ["4050", "4050.0", "4050.00"]) {
      const book: BookSnapshot = bookFromLevels([], [{ price: spelling, size: "1.0000" }], market);
      // Deleting the point would give 4050, 40500 and 405000 — a 100x and a 10x price error.
      expect(book.asks[0]?.priceScaled).toBe(405000n);
      expect(bestPrice(book, false)).toBe(405000n);
    }
  });

  test("a price carrying more precision than the market declares is rejected", () => {
    expect(
      thrownCode((): unknown => bookFromLevels([], [{ price: "4050.001", size: "1.0000" }], diaMarket())),
    ).toBe("ORDER_BOOK_MALFORMED");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Readings                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

describe("bestPrice", () => {
  const book: BookSnapshot = bookFromRestOrders(goldenOrderBookOrders(), btcMarket());

  test("a buy lifts the offer and a sell hits the bid", () => {
    expect(bestPrice(book, false)).toBe(645042n);
    expect(bestPrice(book, true)).toBe(645001n);
  });

  test("an empty side is NO_LIQUIDITY, not a division by zero", () => {
    const empty: BookSnapshot = { bids: [], asks: [] };
    expect(caught((): unknown => bestPrice(empty, false))).toBeInstanceOf(LighterMathError);
    expect(thrownCode((): unknown => bestPrice(empty, true))).toBe("NO_LIQUIDITY");
  });
});

describe("potentialExecutionPrice", () => {
  const market: MarketInfo = diaMarket(); // price 2 dp, size 4 dp, quote 6 dp
  const book: BookSnapshot = bookFromLevels(
    [
      { price: "99.00", size: "1.0000" },
      { price: "98.00", size: "2.0000" },
    ],
    [
      { price: "100.00", size: "0.0001" },
      { price: "101.00", size: "1.0000" },
    ],
    market,
  );

  test("a walk inside the top level averages that level's price exactly", () => {
    const estimate: ExecutionEstimate = potentialExecutionPrice(book, 1n, false, true);
    expect(estimate).toEqual({ avgPriceNum: 10000n, avgPriceDen: 1n, filled: 1n });
  });

  test("a base-sized walk across two levels is an exact weighted average", () => {
    // 1 unit at 10000 + 9 units at 10100 = 100900 quote over 10 base.
    const estimate: ExecutionEstimate = potentialExecutionPrice(book, 10n, false, true);
    expect(estimate).toEqual({ avgPriceNum: 10_090n, avgPriceDen: 1n, filled: 10n });
    expect(estimate.avgPriceNum * 10n).toBe(100_900n * estimate.avgPriceDen);
  });

  test("a quote-sized walk keeps the partial level exact instead of truncating it", () => {
    // 1.000000 quote: 0.010000 fills the top level (1 base unit), the rest is a rational take.
    const estimate: ExecutionEstimate = potentialExecutionPrice(book, 1_000_000n, false, false);
    expect(estimate.filled).toBe(1_000_000n);
    // matchedBase = 1 + 990000/10100 = 1000100/10100, so avg = 1000000 * 10100 / 1000100.
    expect(estimate).toEqual({ avgPriceNum: 101_000_000n, avgPriceDen: 10_001n, filled: 1_000_000n });
    // A walk that truncated the partial take would have taken floor(990000/10100) = 98 units from
    // the second level and stopped at 99 base for 999800 quote — 200 quote units short of the
    // request, systematically and always downward. The exact base here is strictly more than 99.
    expect(estimate.filled * estimate.avgPriceDen).toBeGreaterThan(99n * estimate.avgPriceNum);
  });

  test("a thin book reports what it filled and does not throw", () => {
    const estimate: ExecutionEstimate = potentialExecutionPrice(book, 1_000_000_000n, false, false);
    // The whole visible ask side is 10000 + 101000000 quote units.
    expect(estimate.filled).toBe(10_000n + 101_000_000n);
    expect(estimate.filled).toBeLessThan(1_000_000_000n);
  });

  test("selling walks the bids, buying walks the asks", () => {
    expect(potentialExecutionPrice(book, 1n, true, true).avgPriceNum).toBe(9900n);
    expect(potentialExecutionPrice(book, 1n, false, true).avgPriceNum).toBe(10000n);
  });

  test("an empty opposing side is NO_LIQUIDITY", () => {
    const oneSided: BookSnapshot = bookFromLevels([{ price: "99.00", size: "1.0000" }], [], market);
    expect(thrownCode((): unknown => potentialExecutionPrice(oneSided, 1n, false, true))).toBe("NO_LIQUIDITY");
  });

  test("a non-positive amount is a validation error, not an empty walk", () => {
    expect(caught((): unknown => potentialExecutionPrice(book, 0n, false, true))).toBeInstanceOf(
      LighterValidationError,
    );
  });

  test("a mis-sorted snapshot is refused even when it was not built here", () => {
    const handMade: BookSnapshot = {
      bids: [],
      asks: [
        { priceScaled: 10100n, sizeScaled: 10000n },
        { priceScaled: 10000n, sizeScaled: 10000n },
      ],
    };
    expect(thrownCode((): unknown => potentialExecutionPrice(handMade, 1n, false, true))).toBe(
      "ORDER_BOOK_UNSORTED",
    );
  });
});

describe("reduceFraction", () => {
  test("lowest terms, positive denominator", () => {
    expect(reduceFraction(10n, 4n)).toEqual({ num: 5n, den: 2n });
    expect(reduceFraction(3n, -6n)).toEqual({ num: -1n, den: 2n });
    expect(reduceFraction(0n, 5n)).toEqual({ num: 0n, den: 1n });
  });

  test("a zero denominator is refused", () => {
    expect(caught((): unknown => reduceFraction(1n, 0n))).toBeInstanceOf(LighterValidationError);
  });
});
