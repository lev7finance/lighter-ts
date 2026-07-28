/**
 * Leverage → initial margin fraction.
 *
 * The reference truncates this division, which hands the user *more* leverage than they asked for.
 * The regression tests below pin both of the documented cases (3× and 7×) and the property test
 * states the rule they are instances of.
 */

import { describe, expect, test } from "bun:test";

import type { Fraction } from "../../../src/client/math/book.js";
import { leverageToImf, type LeverageResult } from "../../../src/client/math/leverage.js";
import type { MarketInfo } from "../../../src/client/markets.js";
import { LighterValidationError } from "../../../src/errors.js";
import { caught, diaMarket, perpsMarket, thrownCode } from "./fixtures.js";

const MARKET: MarketInfo = perpsMarket(); // minInitialMarginFraction 200, i.e. 50x maximum

describe("leverageToImf", () => {
  test("rounds the margin fraction up, so the account is never more levered than requested", () => {
    const three: LeverageResult = leverageToImf({ leverage: "3" }, MARKET);
    expect(three.imf).toBe(3_334); // the reference computes 3333, an effective 3.0003x
    expect(three.effectiveLeverage).toEqual({ num: 5_000n, den: 1_667n }); // 2.9994x
    expect(three.clamped).toBe(false);

    const seven: LeverageResult = leverageToImf({ leverage: "7" }, MARKET);
    expect(seven.imf).toBe(1_429); // the reference computes 1428, an effective 7.003x
    expect(seven.effectiveLeverage).toEqual({ num: 10_000n, den: 1_429n }); // 6.997x
  });

  test("the effective leverage is exact, and is never above the request", () => {
    for (const [leverage, imf] of [
      ["1", 10_000],
      ["2", 5_000],
      ["3", 3_334],
      ["5", 2_000],
      ["7.5", 1_334],
      ["10", 1_000],
      ["20", 500],
      ["50", 200],
    ] as const) {
      const result: LeverageResult = leverageToImf({ leverage }, MARKET);
      expect(result.imf).toBe(imf);
      // effective = 10000/imf ≤ requested, cross-multiplied against the requested rational.
      const requested: Fraction = asFraction(leverage);
      expect(result.effectiveLeverage.num * requested.den).toBeLessThanOrEqual(
        requested.num * result.effectiveLeverage.den,
      );
    }
  });

  test("an exact rational leverage is accepted without a decimal string in the middle", () => {
    expect(leverageToImf({ leverage: { num: 10n, den: 3n } }, MARKET).imf).toBe(3_000);
    expect(leverageToImf({ leverage: { num: 1n, den: 1n } }, MARKET).imf).toBe(10_000);
  });

  test("a raw margin fraction round-trips without passing through a leverage", () => {
    const result: LeverageResult = leverageToImf({ initialMarginFraction: 500 }, MARKET);
    expect(result.imf).toBe(500);
    expect(result.effectiveLeverage).toEqual({ num: 20n, den: 1n });
    expect(result.clamped).toBe(false);
  });

  test("more leverage than the market allows is an error, not a silent reduction", () => {
    // The market's floor is 200 bps, i.e. 50x.
    expect(thrownCode((): unknown => leverageToImf({ leverage: "100" }, MARKET))).toBe("IMF_TOO_LOW");
    expect(thrownCode((): unknown => leverageToImf({ initialMarginFraction: 100 }, MARKET))).toBe(
      "IMF_TOO_LOW",
    );
    // 50x exactly is allowed.
    expect(leverageToImf({ leverage: "50" }, MARKET).imf).toBe(200);
  });

  test("below 1x is not expressible, so it is clamped and says so", () => {
    const result: LeverageResult = leverageToImf({ leverage: "0.5" }, MARKET);
    expect(result.imf).toBe(10_000);
    expect(result.effectiveLeverage).toEqual({ num: 1n, den: 1n });
    expect(result.clamped).toBe(true);
  });

  test("a market with no perps metadata is bounded only by the protocol domain", () => {
    const bare: MarketInfo = diaMarket();
    expect(bare.perps).toBeUndefined();
    expect(leverageToImf({ leverage: "10000" }, bare).imf).toBe(1);
    // A margin fraction cannot go below one tick, so a request beyond 10000x lands on 10000x —
    // under the request, which is the safe direction, and visible in `effectiveLeverage`.
    const beyond: LeverageResult = leverageToImf({ leverage: "10001" }, bare);
    expect(beyond.imf).toBe(1);
    expect(beyond.effectiveLeverage).toEqual({ num: 10_000n, den: 1n });
  });

  test("exactly one spelling may be supplied", () => {
    const both: unknown = { leverage: "3", initialMarginFraction: 500 };
    expect(thrownCode((): unknown => leverageToImf(both as { leverage: string }, MARKET))).toBe(
      "LEVERAGE_INVALID",
    );
    expect(thrownCode((): unknown => leverageToImf({} as { leverage: string }, MARKET))).toBe(
      "LEVERAGE_INVALID",
    );
  });

  test("a leverage is never a fractional binary float, and never zero or negative", () => {
    for (const bad of ["0", "0.0", "-3", "3.5e0", "three", ""]) {
      expect(caught((): unknown => leverageToImf({ leverage: bad }, MARKET))).toBeInstanceOf(
        LighterValidationError,
      );
    }
    expect(
      caught((): unknown => leverageToImf({ leverage: 3 as unknown as string }, MARKET)),
    ).toBeInstanceOf(LighterValidationError);
    expect(thrownCode((): unknown => leverageToImf({ initialMarginFraction: 3.5 }, MARKET))).toBe(
      "IMF_INVALID",
    );
    expect(thrownCode((): unknown => leverageToImf({ initialMarginFraction: 0 }, MARKET))).toBe(
      "IMF_INVALID",
    );
    expect(thrownCode((): unknown => leverageToImf({ initialMarginFraction: 10_001 }, MARKET))).toBe(
      "IMF_INVALID",
    );
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Property — the account is never more levered than the request                                    */
/* ---------------------------------------------------------------------------------------------- */

describe("property: the effective leverage never exceeds the requested leverage", () => {
  test("over every representable leverage from 1x to the market's maximum, to four decimals", () => {
    const permissive: MarketInfo = perpsMarket(1);
    let checked: number = 0;
    for (let hundredths: number = 100; hundredths <= 500_000; hundredths += 617) {
      const leverage: string = `${String(Math.trunc(hundredths / 100))}.${String(hundredths % 100).padStart(2, "0")}`;
      const result: LeverageResult = leverageToImf({ leverage }, permissive);
      const requested: Fraction = asFraction(leverage);

      expect(result.clamped).toBe(false);
      expect(result.imf).toBeGreaterThanOrEqual(1);
      expect(result.imf).toBeLessThanOrEqual(10_000);
      // effective ≤ requested
      expect(result.effectiveLeverage.num * requested.den).toBeLessThanOrEqual(
        requested.num * result.effectiveLeverage.den,
      );
      // …and it is the closest such value: one tick less margin would overshoot the request.
      if (result.imf > 1) {
        expect(requested.num * BigInt(result.imf - 1)).toBeLessThan(10_000n * requested.den);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(700);
  });
});

/** The same lexical parse the module performs, restated in the test so the two can disagree. */
function asFraction(leverage: string): Fraction {
  const dot: number = leverage.indexOf(".");
  if (dot < 0) return { num: BigInt(leverage), den: 1n };
  const digits: string = leverage.slice(0, dot) + leverage.slice(dot + 1);
  return { num: BigInt(digits), den: 10n ** BigInt(leverage.length - dot - 1) };
}
