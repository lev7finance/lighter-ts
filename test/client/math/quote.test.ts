/**
 * Quote↔base sizing and the two gates in front of it.
 *
 * The markets are the captured ones wherever the captured values do not mask the arithmetic; where
 * they do — every live market has a $10 minimum notional, which a test about an 8.2 USDC order
 * cannot use — the derivation is labelled in `./fixtures.ts` and changes one field.
 */

import { describe, expect, test } from "bun:test";

import {
  type BookSnapshot,
  bookFromLevels,
  type ExecutionEstimate,
  potentialExecutionPrice,
} from "../../../src/client/math/book.js";
import {
  type BaseSizing,
  baseOrderIfSlippage,
  type QuoteSizing,
  quoteToBase,
} from "../../../src/client/math/quote.js";
import type { MarketInfo } from "../../../src/client/markets.js";
import { LighterMathError } from "../../../src/errors.js";
import { toScaled } from "../../../src/util/decimal.js";
import { caught, crossScaleViolatorMarket, diaMarket, noMinimumMarket, thrownCode } from "./fixtures.js";

/* ---------------------------------------------------------------------------------------------- */
/* Books                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

const MARKET: MarketInfo = noMinimumMarket(); // price 2 dp, size 4 dp, quote 6 dp

/** One deep level at exactly 1.00, so a sizing result is legible by eye. */
function flatBook(size: string = "20.0000"): BookSnapshot {
  return bookFromLevels([{ price: "1.00", size }], [{ price: "1.00", size }], MARKET);
}

/** Two levels: a sliver at the top of book and depth well behind it. */
function steppedBook(): BookSnapshot {
  return bookFromLevels(
    [
      { price: "100.00", size: "0.0001" },
      { price: "50.00", size: "10.0000" },
    ],
    [
      { price: "100.00", size: "0.0001" },
      { price: "200.00", size: "10.0000" },
    ],
    MARKET,
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Hazard 2 — int(quote × 10^6) loses money                                                         */
/* ---------------------------------------------------------------------------------------------- */

describe("hazard 2: a quote amount never goes through a binary float", () => {
  test('"8.2" at 6 decimals is exactly 8200000', () => {
    // The value the reference computes is 8.2 × 10^6 = 8199999.999999999 truncated to 8199999.
    expect(toScaled("8.2", 6, "FLOOR")).toBe(8_200_000n);
  });

  test("sizing 8.2 quote units at a price of 1.00 buys exactly 8.2 base units", () => {
    const sized: QuoteSizing = quoteToBase(flatBook(), MARKET, "8.2", false, "1%");
    // 82000 at 4 size decimals is 8.2 base. One micro-unit short would be 81999.
    expect(sized.baseAmount).toBe(82_000n);
    expect(sized.avgPriceNum).toBe(100n);
    expect(sized.avgPriceDen).toBe(1n);
    expect(sized.price).toBe(101n); // floor(100 × 1.01)
  });

  test("the same value spelled several ways sizes identically", () => {
    for (const spelling of ["8.2", "8.20", "8.200000"]) {
      expect(quoteToBase(flatBook(), MARKET, spelling, false, "1%").baseAmount).toBe(82_000n);
    }
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Hazard 4 — one representation, both branches                                                     */
/* ---------------------------------------------------------------------------------------------- */

describe("hazard 4: quote-sized and base-sized paths agree on their return type", () => {
  test("both return an exact (num, den) pair of bigints, not a rational on one path and a float on the other", () => {
    const book: BookSnapshot = flatBook();
    const sized: QuoteSizing = quoteToBase(book, MARKET, "1.0", false, "1%");
    const gated: BaseSizing = baseOrderIfSlippage(book, MARKET, sized.baseAmount, false, "1%");

    expect(typeof sized.avgPriceNum).toBe("bigint");
    expect(typeof sized.avgPriceDen).toBe("bigint");
    expect(typeof gated.avgPriceNum).toBe("bigint");
    expect(typeof gated.avgPriceDen).toBe("bigint");

    // Same trade, same fraction — the two are comparable, which is the whole point.
    expect({ num: gated.avgPriceNum, den: gated.avgPriceDen }).toEqual({
      num: sized.avgPriceNum,
      den: sized.avgPriceDen,
    });
  });

  test("a fractional average survives both paths in lowest terms", () => {
    const book: BookSnapshot = steppedBook();
    const estimate: ExecutionEstimate = potentialExecutionPrice(book, 3n, false, true);
    // 1 unit at 10000 + 2 at 20000 = 50000 over 3 base: 50000/3 does not reduce.
    expect(estimate.avgPriceNum).toBe(50_000n);
    expect(estimate.avgPriceDen).toBe(3n);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Gates                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

describe("quoteToBase rejections", () => {
  test("a market that cannot express quote sizing is refused outright", () => {
    const error: unknown = caught((): unknown =>
      quoteToBase(flatBook(), crossScaleViolatorMarket(), "1.0", false, "1%"),
    );
    expect(error).toBeInstanceOf(LighterMathError);
    expect((error as LighterMathError).code).toBe("SCALE_INVARIANT_VIOLATED");
  });

  test("an empty book is NO_LIQUIDITY", () => {
    expect(thrownCode((): unknown => quoteToBase({ bids: [], asks: [] }, MARKET, "1.0", false, "1%"))).toBe(
      "NO_LIQUIDITY",
    );
  });

  test("a thin book is INSUFFICIENT_DEPTH, distinctly from a price problem", () => {
    // One sliver at the top of book, worth 0.01 quote units against a request for 1.0, and a
    // slippage tolerance wide enough that price cannot be what fails.
    const sliver: BookSnapshot = bookFromLevels([], [{ price: "100.00", size: "0.0001" }], MARKET);
    expect(thrownCode((): unknown => quoteToBase(sliver, MARKET, "1.0", false, "100%"))).toBe(
      "INSUFFICIENT_DEPTH",
    );
  });

  test("a bound worse than the walk is EXCESSIVE_SLIPPAGE", () => {
    // The book fills at ~199.98 against a cap of 101.
    expect(thrownCode((): unknown => quoteToBase(steppedBook(), MARKET, "1.0", false, "1%"))).toBe(
      "EXCESSIVE_SLIPPAGE",
    );
  });

  test("price is checked before depth, so a book that fails both reports the actionable one", () => {
    const shallowAndExpensive: BookSnapshot = bookFromLevels(
      [],
      [
        { price: "100.00", size: "0.0001" },
        { price: "500.00", size: "0.0001" },
      ],
      MARKET,
    );
    expect(thrownCode((): unknown => quoteToBase(shallowAndExpensive, MARKET, "1.0", false, "1%"))).toBe(
      "EXCESSIVE_SLIPPAGE",
    );
  });

  test("a non-positive quote amount is refused before the book is read", () => {
    expect(thrownCode((): unknown => quoteToBase(flatBook(), MARKET, "0", false, "1%"))).toBe(
      "QUOTE_AMOUNT_TOO_LOW",
    );
    expect(thrownCode((): unknown => quoteToBase(flatBook(), MARKET, "0.0000001", false, "1%"))).toBe(
      "QUOTE_AMOUNT_TOO_LOW",
    );
  });

  test("the market's own notional floor and ceiling are pre-flighted", () => {
    const live: MarketInfo = diaMarket(); // min quote 10.000000, limit 5000000.000000
    const deep: BookSnapshot = bookFromLevels([], [{ price: "1.00", size: "10000000.0000" }], live);
    expect(thrownCode((): unknown => quoteToBase(deep, live, "8.2", false, "1%"))).toBe("QUOTE_AMOUNT_TOO_LOW");
    expect(thrownCode((): unknown => quoteToBase(deep, live, "6000000", false, "1%"))).toBe(
      "QUOTE_AMOUNT_TOO_HIGH",
    );
    expect(quoteToBase(deep, live, "100", false, "1%").baseAmount).toBe(1_000_000n);
  });

  test("the market's minimum base size is pre-flighted", () => {
    const live: MarketInfo = diaMarket(); // min base 0.0100 = 100 units at 4 decimals
    const expensive: BookSnapshot = bookFromLevels([], [{ price: "1000.00", size: "100.0000" }], live);
    // 20 USDC at 1000.00 is 0.02 base — above the 0.01 minimum.
    expect(quoteToBase(expensive, live, "20", false, "1%").baseAmount).toBe(200n);
    // A market whose minimum is raised past that rejects the same order.
    const strict: MarketInfo = { ...live, minBaseAmount: "0.5000" };
    expect(thrownCode((): unknown => quoteToBase(expensive, strict, "20", false, "1%"))).toBe(
      "BASE_AMOUNT_TOO_LOW",
    );
  });
});

describe("baseOrderIfSlippage", () => {
  test("returns the capped price when the walk is inside the bound", () => {
    const gated: BaseSizing = baseOrderIfSlippage(flatBook(), MARKET, 50_000n, true, "0.5%");
    expect(gated.filled).toBe(50_000n);
    expect(gated.avgPriceNum).toBe(100n);
    expect(gated.avgPriceDen).toBe(1n);
    expect(gated.price).toBe(100n); // ceil(100 × 0.995) = ceil(99.5) = 100
  });

  test("rejects on price and on depth, with the same codes as the quote-sized path", () => {
    expect(thrownCode((): unknown => baseOrderIfSlippage(steppedBook(), MARKET, 100n, false, "1%"))).toBe(
      "EXCESSIVE_SLIPPAGE",
    );
    expect(
      thrownCode((): unknown => baseOrderIfSlippage(steppedBook(), MARKET, 1_000_000n, false, "100%")),
    ).toBe("INSUFFICIENT_DEPTH");
  });

  test("a base amount outside the protocol domain never reaches the book", () => {
    expect(thrownCode((): unknown => baseOrderIfSlippage(flatBook(), MARKET, 0n, false, "1%"))).toBe(
      "BASE_AMOUNT_TOO_LOW",
    );
    expect(
      thrownCode((): unknown => baseOrderIfSlippage(flatBook(), MARKET, 2n ** 48n, false, "1%")),
    ).toBe("BASE_AMOUNT_TOO_HIGH");
  });

  test("the caller may supply the ideal price the bound is measured from", () => {
    const book: BookSnapshot = flatBook();
    // A stale mark price of 2.00 makes the bound 2.02 rather than 1.01; the walk is unchanged.
    const gated: BaseSizing = baseOrderIfSlippage(book, MARKET, 1_000n, false, "1%", { idealPrice: 200n });
    expect(gated.price).toBe(202n);
    expect(gated.avgPriceNum).toBe(100n);
  });

  test("aggressive rounding moves the cap by at most one tick", () => {
    const book: BookSnapshot = flatBook();
    const conservative: BaseSizing = baseOrderIfSlippage(book, MARKET, 1_000n, false, "0.5%");
    const aggressive: BaseSizing = baseOrderIfSlippage(book, MARKET, 1_000n, false, "0.5%", {
      mode: "aggressive",
    });
    expect(conservative.price).toBe(100n); // floor(100 × 1.005) = 100
    expect(aggressive.price).toBe(101n); // ceil(100 × 1.005) = 101
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Property — a sized order never commits more than was offered                                     */
/* ---------------------------------------------------------------------------------------------- */

function* seeded(count: number): Generator<bigint> {
  const mask: bigint = (1n << 64n) - 1n;
  let x: bigint = 4_101_842_887_655_102_017n;
  for (let i: number = 0; i < count; i++) {
    x ^= (x << 13n) & mask;
    x ^= x >> 7n;
    x ^= (x << 17n) & mask;
    yield x;
  }
}

describe("property: quoteToBase never yields a notional above the requested quote", () => {
  test("over a seeded corpus of books and quote amounts", () => {
    let sized: number = 0;
    let rejected: number = 0;

    for (const r of seeded(300)) {
      // A book of five ascending levels with irregular prices and sizes.
      const basePrice: bigint = 1n + (r % 500_000n);
      const levels: { price: string; size: string }[] = [];
      let price: bigint = basePrice;
      for (let i: number = 0; i < 5; i++) {
        price += 1n + ((r >> BigInt(3 * (i + 1))) % 97n);
        const size: bigint = 1n + ((r >> BigInt(5 * (i + 1))) % 250_000n);
        levels.push({ price: scaled(price, 2), size: scaled(size, 4) });
      }
      const book: BookSnapshot = bookFromLevels([], levels, MARKET);
      const quote: string = scaled(1n + (r % 5_000_000_000n), 6);

      let result: QuoteSizing;
      try {
        result = quoteToBase(book, MARKET, quote, false, "100%");
      } catch (error: unknown) {
        // With a 100% tolerance the only thing left that can refuse is depth.
        expect((error as { code?: unknown }).code).toBe("INSUFFICIENT_DEPTH");
        rejected++;
        continue;
      }

      const quoteInt: bigint = toScaled(quote, MARKET.quoteDecimals, "FLOOR");
      const committed: bigint = result.baseAmount * result.avgPriceNum;
      // baseAmount × avgPrice ≤ quoteInt, cross-multiplied so nothing is divided out.
      expect(committed).toBeLessThanOrEqual(quoteInt * result.avgPriceDen);
      // …and it is the largest size for which that holds: one more unit would overspend.
      expect((result.baseAmount + 1n) * result.avgPriceNum).toBeGreaterThan(quoteInt * result.avgPriceDen);
      sized++;
    }

    expect(sized).toBeGreaterThan(250); // the corpus mostly sizes; it is not vacuously passing
    expect(sized + rejected).toBe(300);
  });
});

/** A `bigint` of scaled units back into the decimal string a caller would have typed. */
function scaled(units: bigint, decimals: number): string {
  const text: string = units.toString().padStart(decimals + 1, "0");
  return `${text.slice(0, text.length - decimals)}.${text.slice(text.length - decimals)}`;
}
