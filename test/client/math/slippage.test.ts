/**
 * The slippage bound.
 *
 * The property test at the bottom is the point of this file: the invariant "rounding never loosens
 * slippage protection" is asserted mechanically over a seeded corpus, not left to the prose in
 * `docs/decisions.md` D7 — whose illustration of the rule contradicts the rule, and whose formulas
 * (`docs/spec/07-high-level-client.md` §3.5) do not.
 */

import { describe, expect, test } from "bun:test";

import type { Fraction } from "../../../src/client/math/book.js";
import {
  MAX_ORDER_PRICE,
  parseSlippage,
  roundingFor,
  slippageBound,
} from "../../../src/client/math/slippage.js";
import { LighterMathError, LighterValidationError } from "../../../src/errors.js";
import { caught, thrownCode } from "./fixtures.js";

/* ---------------------------------------------------------------------------------------------- */
/* Parsing                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

describe("parseSlippage", () => {
  test("three spellings of one half of one percent", () => {
    expect(parseSlippage("0.005")).toEqual({ num: 1n, den: 200n });
    expect(parseSlippage("0.5%")).toEqual({ num: 1n, den: 200n });
    expect(parseSlippage("50bps")).toEqual({ num: 1n, den: 200n });
    expect(parseSlippage("50BPS")).toEqual({ num: 1n, den: 200n });
  });

  test("zero has several spellings and they all reduce to the same fraction", () => {
    expect(parseSlippage("0")).toEqual({ num: 0n, den: 1n });
    expect(parseSlippage("0.0000")).toEqual({ num: 0n, den: 1n });
    expect(parseSlippage("0%")).toEqual({ num: 0n, den: 1n });
    expect(parseSlippage("0bps")).toEqual({ num: 0n, den: 1n });
  });

  test("exact for a value no binary float can hold", () => {
    expect(parseSlippage("0.1")).toEqual({ num: 1n, den: 10n });
    expect(parseSlippage("0.000001")).toEqual({ num: 1n, den: 1_000_000n });
    expect(parseSlippage("1")).toEqual({ num: 1n, den: 1n });
  });

  test("anything that smells of a numeric parser is rejected", () => {
    for (const bad of ["1e-3", ".5", "5.", "+0.5", " 0.5", "0.5 ", "0.5 %", "abc", "", "0x1", "1.2.3"]) {
      expect(caught((): unknown => parseSlippage(bad))).toBeInstanceOf(LighterValidationError);
    }
  });

  test("the domain is [0, 1]", () => {
    expect(thrownCode((): unknown => parseSlippage("-0.1"))).toBe("SLIPPAGE_INVALID"); // the sign is not even lexed
    expect(thrownCode((): unknown => parseSlippage("1.0001"))).toBe("SLIPPAGE_OUT_OF_RANGE");
    expect(thrownCode((): unknown => parseSlippage("101%"))).toBe("SLIPPAGE_OUT_OF_RANGE");
    expect(thrownCode((): unknown => parseSlippage("10001bps"))).toBe("SLIPPAGE_OUT_OF_RANGE");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Direction                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

describe("rounding direction", () => {
  test("conservative floors a buy's ceiling and ceils a sell's floor", () => {
    expect(roundingFor(false)).toBe("FLOOR");
    expect(roundingFor(true)).toBe("CEIL");
    expect(roundingFor(false, "aggressive")).toBe("CEIL");
    expect(roundingFor(true, "aggressive")).toBe("FLOOR");
  });

  test("an unknown mode is refused rather than defaulted", () => {
    expect(caught((): unknown => roundingFor(false, "half-up" as "conservative"))).toBeInstanceOf(
      LighterValidationError,
    );
  });

  test("a buy's bound is above its ideal price and a sell's is below", () => {
    expect(slippageBound(10_000n, "1%", false)).toBe(10_100n);
    expect(slippageBound(10_000n, "1%", true)).toBe(9_900n);
  });

  test("zero slippage is the ideal price on both sides and in both modes", () => {
    for (const isAsk of [false, true]) {
      expect(slippageBound(12_345n, "0", isAsk)).toBe(12_345n);
      expect(slippageBound(12_345n, "0", isAsk, "aggressive")).toBe(12_345n);
    }
  });

  test("a fraction may be supplied directly, already exact", () => {
    const fraction: Fraction = { num: 1n, den: 200n };
    expect(slippageBound(10_000n, fraction, false)).toBe(slippageBound(10_000n, "0.5%", false));
    expect(thrownCode((): unknown => slippageBound(10_000n, { num: -1n, den: 200n }, false))).toBe(
      "SLIPPAGE_OUT_OF_RANGE",
    );
    expect(thrownCode((): unknown => slippageBound(10_000n, { num: 1n, den: 0n }, false))).toBe(
      "SLIPPAGE_INVALID",
    );
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Hazard 1 — round() is not the JavaScript rounding built-in, and neither is a slippage bound       */
/* ---------------------------------------------------------------------------------------------- */

describe("hazard 1: banker's rounding, half-up rounding, and the rule that is neither", () => {
  test("at an even half the two nearest-rules disagree, and the bound follows neither", () => {
    // ideal 1500 at 0.1%: a buy's exact bound is 1501.5 and a sell's is 1498.5.
    // Python's round() is half-to-even: 1502 and 1498. The JavaScript built-in is half-up: 1502
    // and 1499. Neither knows which direction protects the caller.
    const buy: bigint = slippageBound(1_500n, "0.1%", false);
    const sell: bigint = slippageBound(1_500n, "0.1%", true);

    expect(buy).toBe(1_501n); // floor: below both nearest-rules' answer of 1502
    expect(sell).toBe(1_499n); // ceil: above half-to-even's answer of 1498

    // Stated as the thing that actually matters: the bound is never on the permissive side of the
    // exact rational, whichever way the tie would have gone.
    expect(buy * 1_000n).toBeLessThanOrEqual(1_500n * 1_001n);
    expect(sell * 1_000n).toBeGreaterThanOrEqual(1_500n * 999n);

    // And aggressive is the other tick, so between them they bracket the exact value by one.
    expect(slippageBound(1_500n, "0.1%", false, "aggressive")).toBe(1_502n);
    expect(slippageBound(1_500n, "0.1%", true, "aggressive")).toBe(1_498n);
  });

  test("the documented 2500.5 case, on the side where the two rules differ", () => {
    // 5001 * (1 - 0.5) = 2500.5. Half-to-even says 2500, half-up says 2501, and a sell's floor
    // price rounds up because rounding it down would accept less than the caller agreed to.
    expect(slippageBound(5_001n, "50%", true)).toBe(2_501n);
    // 1667 * (1 + 0.5) = 2500.5 as well; a buy's cap rounds down for the mirror-image reason.
    expect(slippageBound(1_667n, "50%", false)).toBe(2_500n);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Domain                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

describe("the representable range", () => {
  test("a sell bound that rounds to zero is NOT_REPRESENTABLE, never NilOrderPrice", () => {
    const error: unknown = caught((): unknown => slippageBound(1n, "100%", true));
    expect(error).toBeInstanceOf(LighterMathError);
    expect((error as LighterMathError).code).toBe("NOT_REPRESENTABLE");
  });

  test("a bound above MaxOrderPrice is clamped, which can only tighten a buy", () => {
    expect(slippageBound(MAX_ORDER_PRICE, "10%", false)).toBe(MAX_ORDER_PRICE);
    expect(slippageBound(MAX_ORDER_PRICE, "10%", true)).toBeLessThan(MAX_ORDER_PRICE);
  });

  test("an ideal price outside the protocol domain is refused", () => {
    expect(thrownCode((): unknown => slippageBound(0n, "1%", false))).toBe("PRICE_TOO_LOW");
    expect(thrownCode((): unknown => slippageBound(-5n, "1%", false))).toBe("PRICE_TOO_LOW");
    expect(thrownCode((): unknown => slippageBound(MAX_ORDER_PRICE + 1n, "1%", false))).toBe("PRICE_TOO_HIGH");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Property — the invariant, mechanically                                                           */
/* ---------------------------------------------------------------------------------------------- */

/** xorshift64: a seeded, reproducible corpus that does not depend on a random source. */
function* seeded(count: number): Generator<bigint> {
  const mask: bigint = (1n << 64n) - 1n;
  let x: bigint = 88_172_645_463_325_252n;
  for (let i: number = 0; i < count; i++) {
    x ^= (x << 13n) & mask;
    x ^= x >> 7n;
    x ^= (x << 17n) & mask;
    yield x;
  }
}

const SLIPPAGES: readonly string[] = [
  "0",
  "1bps",
  "0.0007",
  "0.001",
  "0.005",
  "0.5%",
  "1%",
  "2.5%",
  "10%",
  "33.333333%",
  "50%",
  "99.99%",
  "100%",
];

describe("property: the conservative bound is never more permissive than the exact bound", () => {
  test("over a seeded corpus of (idealPrice, slippage) pairs, on both sides", () => {
    let checked: number = 0;
    for (const r of seeded(400)) {
      const idealPrice: bigint = 1n + (r % MAX_ORDER_PRICE);
      const slippage: string = SLIPPAGES[Number(r % BigInt(SLIPPAGES.length))] ?? "1%";
      const fraction: Fraction = parseSlippage(slippage);

      // A buy's cap must not exceed the exact rational cap.
      const buy: bigint = slippageBound(idealPrice, slippage, false);
      const exactBuyNum: bigint = idealPrice * (fraction.den + fraction.num);
      expect(buy * fraction.den).toBeLessThanOrEqual(exactBuyNum);
      // …and it must be the *tightest* such integer, i.e. no more than one tick away, unless the
      // protocol ceiling bit first.
      if (buy < MAX_ORDER_PRICE) {
        expect((buy + 1n) * fraction.den).toBeGreaterThan(exactBuyNum);
      }

      // A sell's floor must not fall below the exact rational floor.
      const exactSellNum: bigint = idealPrice * (fraction.den - fraction.num);
      if (exactSellNum > 0n) {
        const sell: bigint = slippageBound(idealPrice, slippage, true);
        expect(sell * fraction.den).toBeGreaterThanOrEqual(exactSellNum);
        expect((sell - 1n) * fraction.den).toBeLessThan(exactSellNum);
      } else {
        // A floor price of exactly zero is NilOrderPrice, not "any price", and it says so.
        expect(thrownCode((): unknown => slippageBound(idealPrice, slippage, true))).toBe(
          "NOT_REPRESENTABLE",
        );
      }
      checked++;
    }
    expect(checked).toBe(400);
  });

  test("the bound is monotone in the slippage, on both sides", () => {
    const ordered: readonly string[] = ["0", "1bps", "0.001", "0.5%", "1%", "10%", "50%"];
    for (const r of seeded(60)) {
      const idealPrice: bigint = 1n + (r % 1_000_000n);
      let previousBuy: bigint = 0n;
      let previousSell: bigint = MAX_ORDER_PRICE;
      for (const slippage of ordered) {
        const buy: bigint = slippageBound(idealPrice, slippage, false);
        expect(buy).toBeGreaterThanOrEqual(previousBuy);
        previousBuy = buy;

        const fraction: Fraction = parseSlippage(slippage);
        if (idealPrice * (fraction.den - fraction.num) > 0n) {
          const sell: bigint = slippageBound(idealPrice, slippage, true);
          expect(sell).toBeLessThanOrEqual(previousSell);
          previousSell = sell;
        }
      }
    }
  });

  test("aggressive is never tighter than conservative, and never more than one tick apart", () => {
    for (const r of seeded(120)) {
      const idealPrice: bigint = 1n + (r % 1_000_000n);
      const slippage: string = SLIPPAGES[Number(r % BigInt(SLIPPAGES.length))] ?? "1%";
      const buyC: bigint = slippageBound(idealPrice, slippage, false);
      const buyA: bigint = slippageBound(idealPrice, slippage, false, "aggressive");
      expect(buyA).toBeGreaterThanOrEqual(buyC);
      expect(buyA - buyC).toBeLessThanOrEqual(1n);
    }
  });
});
