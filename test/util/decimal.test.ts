import { describe, expect, test } from "bun:test";

import { LighterMathError, LighterValidationError } from "../../src/errors.js";
import {
  compareDecimal,
  divRound,
  fromScaled,
  normalizeDecimal,
  parseDecimal,
  rescale,
  toScaled,
} from "../../src/util/decimal.js";
import type { RoundingMode } from "../../src/util/decimal.js";

const ALL_MODES: readonly RoundingMode[] = ["EXACT", "FLOOR", "CEIL", "HALF_EVEN"];

describe("parseDecimal", () => {
  test("decomposes exactly, without a numeric parser", () => {
    expect(parseDecimal("0")).toEqual({ unscaled: 0n, scale: 0 });
    expect(parseDecimal("2500.1")).toEqual({ unscaled: 25001n, scale: 1 });
    expect(parseDecimal("8.2")).toEqual({ unscaled: 82n, scale: 1 });
    expect(parseDecimal("-0.001")).toEqual({ unscaled: -1n, scale: 3 });
    expect(parseDecimal("-0")).toEqual({ unscaled: 0n, scale: 0 });
    expect(parseDecimal("007.50")).toEqual({ unscaled: 750n, scale: 2 });
  });

  test("keeps precision no double could hold", () => {
    const s = "123456789012345678901234567890.123456789012345678";
    const parsed = parseDecimal(s);
    expect(parsed.unscaled).toBe(123456789012345678901234567890123456789012345678n);
    expect(parsed.scale).toBe(18);
  });

  test("rejects everything the wire never produces", () => {
    for (const bad of [
      "1e6",
      "1E6",
      "NaN",
      "Infinity",
      "-Infinity",
      " 1.0",
      "1.0 ",
      "1.2.3",
      "",
      ".",
      ".5",
      "5.",
      "+1",
      "1,5",
      "0x10",
      "--1",
      "1_000",
    ]) {
      expect(() => parseDecimal(bad)).toThrow(LighterValidationError);
    }
  });

  test("rejects a non-string without coercing it", () => {
    expect(() => parseDecimal(1.5 as unknown as string)).toThrow(LighterValidationError);
    expect(() => parseDecimal(null as unknown as string)).toThrow(LighterValidationError);
  });
});

describe("divRound", () => {
  test("negative numerators — bigint division truncates toward zero, FLOOR must not", () => {
    expect(divRound(-7n, 2n, "FLOOR")).toBe(-4n);
    expect(divRound(-7n, 2n, "CEIL")).toBe(-3n);
    expect(divRound(7n, 2n, "FLOOR")).toBe(3n);
    expect(divRound(7n, 2n, "CEIL")).toBe(4n);
    expect(-7n / 2n).toBe(-3n); // the trap this guards against
  });

  test("HALF_EVEN ties go to the even quotient, symmetrically about zero", () => {
    expect(divRound(5n, 2n, "HALF_EVEN")).toBe(2n);
    expect(divRound(-5n, 2n, "HALF_EVEN")).toBe(-2n);
    expect(divRound(7n, 2n, "HALF_EVEN")).toBe(4n);
    expect(divRound(-7n, 2n, "HALF_EVEN")).toBe(-4n);
    expect(divRound(1n, 2n, "HALF_EVEN")).toBe(0n);
    expect(divRound(-1n, 2n, "HALF_EVEN")).toBe(0n);
    expect(divRound(3n, 2n, "HALF_EVEN")).toBe(2n);
  });

  test("HALF_EVEN off a tie rounds to nearest", () => {
    expect(divRound(14n, 10n, "HALF_EVEN")).toBe(1n);
    expect(divRound(16n, 10n, "HALF_EVEN")).toBe(2n);
    expect(divRound(15n, 10n, "HALF_EVEN")).toBe(2n);
    expect(divRound(25n, 10n, "HALF_EVEN")).toBe(2n);
    expect(divRound(-14n, 10n, "HALF_EVEN")).toBe(-1n);
    expect(divRound(-16n, 10n, "HALF_EVEN")).toBe(-2n);
    expect(divRound(-25n, 10n, "HALF_EVEN")).toBe(-2n);
  });

  test("the banker's-rounding hazard from protocol-notes §9.1, over integers", () => {
    // round(2500.5) is 2500 in Python and 2501 with the JavaScript built-in.
    expect(divRound(25005n, 10n, "HALF_EVEN")).toBe(2500n);
    expect(divRound(25015n, 10n, "HALF_EVEN")).toBe(2502n);
  });

  test("EXACT throws on any remainder and returns on none", () => {
    expect(() => divRound(7n, 2n, "EXACT")).toThrow(LighterMathError);
    expect(divRound(8n, 2n, "EXACT")).toBe(4n);
    expect(divRound(-8n, 2n, "EXACT")).toBe(-4n);
    try {
      divRound(7n, 2n, "EXACT");
      throw new Error("expected a throw");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(LighterMathError);
      expect((e as LighterMathError).code).toBe("NOT_REPRESENTABLE");
    }
  });

  test("an exact division is mode-independent", () => {
    for (const mode of ALL_MODES) {
      expect(divRound(-100n, 4n, mode)).toBe(-25n);
      expect(divRound(0n, 7n, mode)).toBe(0n);
    }
  });

  test("negative denominators are normalised onto the numerator", () => {
    expect(divRound(7n, -2n, "FLOOR")).toBe(-4n);
    expect(divRound(-7n, -2n, "FLOOR")).toBe(3n);
    expect(divRound(7n, -2n, "CEIL")).toBe(-3n);
    expect(divRound(5n, -2n, "HALF_EVEN")).toBe(-2n);
  });

  test("division by zero is a validation error, not an exception from the engine", () => {
    expect(() => divRound(1n, 0n, "FLOOR")).toThrow(LighterValidationError);
  });

  test("an unknown mode is rejected rather than silently truncating", () => {
    expect(() => divRound(7n, 2n, "TRUNCATE" as RoundingMode)).toThrow(LighterValidationError);
  });
});

describe("toScaled", () => {
  test("protocol-notes §9.2 — 8.2 USDC is 8200000, not 8199999", () => {
    expect(toScaled("8.2", 6, "EXACT")).toBe(8200000n);
    expect(toScaled("1.234567", 6, "EXACT")).toBe(1234567n);
    // What the reference does: int(8.2 * 1e6).
    expect(BigInt(Math.trunc(8.2 * 1e6))).toBe(8199999n);
  });

  test("protocol-notes §9.3 — shifting, never stripping the decimal point", () => {
    expect(toScaled("2500.1", 2, "EXACT")).toBe(250010n);
    expect(BigInt("2500.1".replace(".", ""))).toBe(25001n); // the reference's accident
    expect(toScaled("2500.10", 2, "EXACT")).toBe(250010n);
    expect(toScaled("2500", 2, "EXACT")).toBe(250000n);
  });

  test("a value below the target precision is EXACT-refused and directionally rounded", () => {
    expect(() => toScaled("0.0000001", 6, "EXACT")).toThrow(LighterMathError);
    try {
      toScaled("0.0000001", 6, "EXACT");
      throw new Error("expected a throw");
    } catch (e: unknown) {
      expect((e as LighterMathError).code).toBe("NOT_REPRESENTABLE");
    }
    expect(toScaled("0.0000001", 6, "FLOOR")).toBe(0n);
    expect(toScaled("0.0000001", 6, "CEIL")).toBe(1n);
    expect(toScaled("0.0000001", 6, "HALF_EVEN")).toBe(0n);
    expect(toScaled("0.0000005", 6, "HALF_EVEN")).toBe(0n); // tie -> even
    expect(toScaled("0.0000015", 6, "HALF_EVEN")).toBe(2n); // tie -> even
  });

  test("negative amounts round toward -infinity under FLOOR, not toward zero", () => {
    // L2UpdateMargin.USDCAmount accepts -1; PnL and funding are signed.
    expect(toScaled("-0.0000001", 6, "FLOOR")).toBe(-1n);
    expect(toScaled("-0.0000001", 6, "CEIL")).toBe(0n);
    expect(toScaled("-1.5", 0, "FLOOR")).toBe(-2n);
    expect(toScaled("-1.5", 0, "CEIL")).toBe(-1n);
    expect(toScaled("-1.5", 0, "HALF_EVEN")).toBe(-2n);
  });

  test("zero decimals and the upper bound", () => {
    expect(toScaled("42", 0, "EXACT")).toBe(42n);
    expect(toScaled("-0", 6, "EXACT")).toBe(0n);
    expect(toScaled("1", 36, "EXACT")).toBe(10n ** 36n);
  });

  test("rejects an out-of-range or non-integer decimals argument", () => {
    for (const bad of [-1, 37, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => toScaled("1", bad, "EXACT")).toThrow(LighterValidationError);
      expect(() => fromScaled(1n, bad)).toThrow(LighterValidationError);
    }
  });
});

describe("fromScaled", () => {
  test("emits exactly `decimals` fraction digits, with no trimming and no -0", () => {
    expect(fromScaled(0n, 6)).toBe("0.000000");
    expect(fromScaled(-1n, 6)).toBe("-0.000001");
    expect(fromScaled(8200000n, 6)).toBe("8.200000");
    expect(fromScaled(250010n, 2)).toBe("2500.10");
    expect(fromScaled(0n, 0)).toBe("0");
    expect(fromScaled(-42n, 0)).toBe("-42");
    expect(fromScaled(1n, 18)).toBe("0.000000000000000001");
  });

  test("round trips against toScaled for both signs", () => {
    for (const s of ["0.000000", "8.200000", "-8.200000", "2500.100000", "-0.000001"]) {
      expect(fromScaled(toScaled(s, 6, "EXACT"), 6)).toBe(s);
    }
  });
});

describe("rescale", () => {
  test("widening is exact, narrowing obeys the mode", () => {
    expect(rescale(8200000n, 6, 8, "EXACT")).toBe(820000000n);
    expect(rescale(8200000n, 6, 6, "EXACT")).toBe(8200000n);
    expect(rescale(8200000n, 6, 2, "EXACT")).toBe(820n);
    expect(() => rescale(8200001n, 6, 2, "EXACT")).toThrow(LighterMathError);
    expect(rescale(8200001n, 6, 2, "FLOOR")).toBe(820n);
    expect(rescale(8200001n, 6, 2, "CEIL")).toBe(821n);
    expect(rescale(-8200001n, 6, 2, "FLOOR")).toBe(-821n);
    expect(rescale(-8200001n, 6, 2, "CEIL")).toBe(-820n);
  });

  test("rejects an out-of-range decimals on either side", () => {
    expect(() => rescale(1n, -1, 2, "EXACT")).toThrow(LighterValidationError);
    expect(() => rescale(1n, 2, 37, "EXACT")).toThrow(LighterValidationError);
  });
});

describe("normalizeDecimal", () => {
  test("re-expresses a string at the market's declared precision", () => {
    expect(normalizeDecimal("2500.1", 2, "EXACT")).toBe("2500.10");
    expect(normalizeDecimal("8.2", 6, "EXACT")).toBe("8.200000");
    expect(normalizeDecimal("-0.5", 0, "FLOOR")).toBe("-1");
    expect(normalizeDecimal("-0.5", 0, "CEIL")).toBe("0");
    expect(normalizeDecimal("0", 4, "EXACT")).toBe("0.0000");
    expect(() => normalizeDecimal("2500.125", 2, "EXACT")).toThrow(LighterMathError);
  });
});

describe("compareDecimal", () => {
  test("compares by value, aligning scales", () => {
    expect(compareDecimal("0.10", "0.1")).toBe(0);
    expect(compareDecimal("0.1", "0.09999999999999999999")).toBe(1);
    expect(compareDecimal("0.09999999999999999999", "0.1")).toBe(-1);
    expect(compareDecimal("2500", "2500.00")).toBe(0);
    expect(compareDecimal("-0", "0")).toBe(0);
    expect(compareDecimal("-1", "1")).toBe(-1);
    expect(compareDecimal("-1.5", "-1.50")).toBe(0);
    expect(compareDecimal("-1.5", "-1.6")).toBe(1);
  });

  test("separates values a double cannot", () => {
    // 0.1 + 0.2 territory: these two are equal in binary64 and must not be equal here.
    expect(compareDecimal("9007199254740992", "9007199254740993")).toBe(-1);
    expect(compareDecimal("0.30000000000000004", "0.3")).toBe(1);
  });

  test("rejects a malformed operand rather than guessing", () => {
    expect(() => compareDecimal("1e6", "1")).toThrow(LighterValidationError);
    expect(() => compareDecimal("1", "")).toThrow(LighterValidationError);
  });

  test("is a total order consistent with itself", () => {
    const values: readonly string[] = ["-2", "-1.5", "-0.000001", "0", "0.1", "0.10", "1", "2500.10"];
    for (const a of values) {
      for (const b of values) {
        expect(compareDecimal(a, b)).toBe((0 - compareDecimal(b, a)) as -1 | 0 | 1);
      }
    }
  });
});
