import { describe, expect, test } from "bun:test";

import { LighterValidationError, isLighterError } from "../../src/errors.js";
import type { I16, I64, U16, U32, U64, U8 } from "../../src/tx/brands.js";
import { i16, i64, u16, u32, u64, u8 } from "../../src/tx/brands.js";

/** Capture the thrown value so `code` and `bound` can be inspected, not just the class. */
function thrown(fn: () => unknown): LighterValidationError {
  try {
    fn();
  } catch (e: unknown) {
    expect(e).toBeInstanceOf(LighterValidationError);
    expect(isLighterError(e)).toBe(true);
    return e as LighterValidationError;
  }
  throw new Error("expected a throw, got a value");
}

describe("u8", () => {
  test("accepts the full range at both ends", () => {
    expect(u8(0)).toBe(0 as U8);
    expect(u8(255)).toBe(255 as U8);
    expect(u8(128)).toBe(128 as U8);
  });

  test("accepts 255 without special-casing it — NilApiKeyIndex is the validators' rule", () => {
    expect(u8(255)).toBe(255 as U8);
  });

  test("rejects one step outside, at both ends", () => {
    expect(thrown(() => u8(-1)).code).toBe("VALUE_TOO_LOW");
    expect(thrown(() => u8(-1)).bound).toBe(0);
    expect(thrown(() => u8(256)).code).toBe("VALUE_TOO_HIGH");
    expect(thrown(() => u8(256)).bound).toBe(255);
  });

  test("rejects non-integers", () => {
    expect(thrown(() => u8(1.5)).code).toBe("UNSAFE_INTEGER");
    expect(thrown(() => u8(Number.NaN)).code).toBe("UNSAFE_INTEGER");
    expect(thrown(() => u8(Number.POSITIVE_INFINITY)).code).toBe("UNSAFE_INTEGER");
    expect(thrown(() => u8(-0.0001)).code).toBe("UNSAFE_INTEGER");
  });
});

describe("u16", () => {
  test("accepts the full range at both ends", () => {
    expect(u16(0)).toBe(0 as U16);
    expect(u16(65535)).toBe(65535 as U16);
  });

  test("rejects one step outside, at both ends", () => {
    expect(thrown(() => u16(-1)).code).toBe("VALUE_TOO_LOW");
    expect(thrown(() => u16(65536)).code).toBe("VALUE_TOO_HIGH");
    expect(thrown(() => u16(65536)).bound).toBe(65535);
  });
});

describe("i16", () => {
  test("accepts the full signed range at both ends", () => {
    expect(i16(-32768)).toBe(-32768 as I16);
    expect(i16(32767)).toBe(32767 as I16);
    expect(i16(0)).toBe(0 as I16);
  });

  test("accepts -1, which is reachable for a market index", () => {
    expect(i16(-1)).toBe(-1 as I16);
  });

  test("accepts the market-index sentinels and family bounds", () => {
    expect(i16(255)).toBe(255 as I16); // NilMarketIndex
    expect(i16(2048)).toBe(2048 as I16); // MinSpotMarketIndex
    expect(i16(4094)).toBe(4094 as I16); // MaxSpotMarketIndex
  });

  test("rejects one step outside, at both ends", () => {
    expect(thrown(() => i16(-32769)).code).toBe("VALUE_TOO_LOW");
    expect(thrown(() => i16(-32769)).bound).toBe(-32768);
    expect(thrown(() => i16(32768)).code).toBe("VALUE_TOO_HIGH");
    expect(thrown(() => i16(32768)).bound).toBe(32767);
  });
});

describe("u32", () => {
  test("accepts the full range at both ends", () => {
    expect(u32(0)).toBe(0 as U32);
    expect(u32(4294967295)).toBe(4294967295 as U32);
  });

  test("rejects one step outside, at both ends", () => {
    expect(thrown(() => u32(-1)).code).toBe("VALUE_TOO_LOW");
    expect(thrown(() => u32(4294967296)).code).toBe("VALUE_TOO_HIGH");
    expect(thrown(() => u32(4294967296)).bound).toBe(4294967295);
  });
});

describe("i64", () => {
  test("accepts the full range at both ends", () => {
    expect(i64(-9223372036854775808n)).toBe(-9223372036854775808n as I64);
    expect(i64(9223372036854775807n)).toBe(9223372036854775807n as I64);
  });

  test("accepts -1n, which is MinAccountIndex and legal", () => {
    expect(i64(-1n)).toBe(-1n as I64);
    expect(i64(-1)).toBe(-1n as I64);
  });

  test("rejects one step outside, at both ends", () => {
    expect(thrown(() => i64(-9223372036854775809n)).code).toBe("VALUE_TOO_LOW");
    expect(thrown(() => i64(-9223372036854775809n)).bound).toBe(-9223372036854775808n);
    expect(thrown(() => i64(9223372036854775808n)).code).toBe("VALUE_TOO_HIGH");
    expect(thrown(() => i64(9223372036854775808n)).bound).toBe(9223372036854775807n);
  });

  test("coerces a safe number exactly once", () => {
    expect(i64(0)).toBe(0n as I64);
    expect(i64(1_700_000_000_000)).toBe(1_700_000_000_000n as I64);
    expect(i64(Number.MAX_SAFE_INTEGER)).toBe(9007199254740991n as I64);
    expect(i64(-Number.MAX_SAFE_INTEGER)).toBe(-9007199254740991n as I64);
  });

  /**
   * The hazard this constructor exists for. `2 ** 53` is inside `int64` but outside the range where
   * `number` can name adjacent integers, so accepting it would mean silently signing a value the
   * caller may not have written.
   */
  test("a number past the safe range throws UNSAFE_INTEGER rather than coercing", () => {
    expect(thrown(() => i64(2 ** 53)).code).toBe("UNSAFE_INTEGER");
    expect(thrown(() => i64(-(2 ** 53))).code).toBe("UNSAFE_INTEGER");
    expect(thrown(() => i64(1e300)).code).toBe("UNSAFE_INTEGER");
  });

  test("the same magnitude as a bigint succeeds", () => {
    expect(i64(9007199254740993n)).toBe(9007199254740993n as I64);
    expect(i64(9007199254740992n)).toBe(9007199254740992n as I64);
  });

  test("rejects fractional and non-finite numbers", () => {
    expect(thrown(() => i64(1.5)).code).toBe("UNSAFE_INTEGER");
    expect(thrown(() => i64(Number.NaN)).code).toBe("UNSAFE_INTEGER");
    expect(thrown(() => i64(Number.NEGATIVE_INFINITY)).code).toBe("UNSAFE_INTEGER");
  });
});

describe("u64", () => {
  test("accepts the full range at both ends", () => {
    expect(u64(0n)).toBe(0n as U64);
    expect(u64(18446744073709551615n)).toBe(18446744073709551615n as U64);
  });

  test("rejects one step outside, at both ends", () => {
    expect(thrown(() => u64(-1n)).code).toBe("VALUE_TOO_LOW");
    expect(thrown(() => u64(-1n)).bound).toBe(0n);
    expect(thrown(() => u64(18446744073709551616n)).code).toBe("VALUE_TOO_HIGH");
    expect(thrown(() => u64(18446744073709551616n)).bound).toBe(18446744073709551615n);
  });

  test("a number past the safe range throws UNSAFE_INTEGER", () => {
    expect(thrown(() => u64(2 ** 53)).code).toBe("UNSAFE_INTEGER");
  });

  test("rejects a negative number as out of range, not as unsafe", () => {
    expect(thrown(() => u64(-1)).code).toBe("VALUE_TOO_LOW");
  });
});

describe("error shape", () => {
  test("every failure is a LighterValidationError with kind 'validation'", () => {
    for (const fn of [
      (): unknown => u8(256),
      (): unknown => u16(-1),
      (): unknown => i16(32768),
      (): unknown => u32(-1),
      (): unknown => i64(2 ** 53),
      (): unknown => u64(-1n),
    ]) {
      const e: LighterValidationError = thrown(fn);
      expect(e.kind).toBe("validation");
      expect(e.name).toBe("LighterValidationError");
      expect(typeof e.message).toBe("string");
      expect(e.message.length).toBeGreaterThan(0);
    }
  });

  test("range failures carry the violated bound with the width's own type", () => {
    expect(typeof thrown(() => u8(256)).bound).toBe("number");
    expect(typeof thrown(() => u64(-1n)).bound).toBe("bigint");
  });

  test("UNSAFE_INTEGER carries no bound — nothing was compared", () => {
    expect(thrown(() => i64(2 ** 53)).bound).toBeUndefined();
    expect(thrown(() => u8(1.5)).bound).toBeUndefined();
  });

  test("serialises without throwing on a bigint bound", () => {
    const json: Record<string, unknown> = thrown(() => u64(-1n)).toJSON();
    expect(json["code"]).toBe("VALUE_TOO_LOW");
    expect(JSON.stringify(json)).toContain("VALUE_TOO_LOW");
  });
});

describe("runtime transparency", () => {
  test("branded numbers are plain numbers and branded 64-bit values are plain bigints", () => {
    expect(typeof u8(1)).toBe("number");
    expect(typeof u16(1)).toBe("number");
    expect(typeof i16(1)).toBe("number");
    expect(typeof u32(1)).toBe("number");
    expect(typeof i64(1n)).toBe("bigint");
    expect(typeof u64(1n)).toBe("bigint");
  });

  test("arithmetic and comparison work unchanged", () => {
    expect(u32(2) + u32(3)).toBe(5);
    expect(i64(2n) * i64(3n)).toBe(6n);
    expect(u8(1) < u8(2)).toBe(true);
  });
});

describe("compile-time brands", () => {
  /**
   * These assertions are checked by `tsc`, not at runtime. Each `@ts-expect-error` fails the
   * typecheck if the assignment ever becomes legal — i.e. if a brand is dropped or two widths are
   * accidentally unified.
   */
  test("distinct widths are not interchangeable", () => {
    // @ts-expect-error a U32 is not an I16
    const a: I16 = u32(1);
    // @ts-expect-error an I64 is not a U64
    const b: U64 = i64(1n);
    // @ts-expect-error a U8 is not a U16
    const c: U16 = u8(1);
    // @ts-expect-error a raw number is not branded
    const d: U8 = 1;
    // @ts-expect-error a raw bigint is not branded
    const e: I64 = 1n;

    // Branded values still widen to their carrier type.
    const asNumber: number = u32(7);
    const asBigInt: bigint = u64(7n);

    expect([a, b, c, d, e]).toBeDefined();
    expect(asNumber).toBe(7);
    expect(asBigInt).toBe(7n);
  });
});
