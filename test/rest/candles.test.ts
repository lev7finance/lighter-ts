/**
 * The candle mapping.
 *
 * Two classes of failure are being guarded against, and neither one announces itself:
 *
 * 1. **A `v`/`V` swap.** The fixture's base and quote volumes differ by four orders of magnitude,
 *    so a swap changes the assertion by a factor of ~14 000 and cannot pass by coincidence. A
 *    fixture where the two happened to be similar would let the bug through forever.
 * 2. **Precision added by the conversion itself.** `docs/decisions.md` D7 forbids `number` on the
 *    money path, and `docs/protocol-notes.md` §9 records the four arithmetic hazards in the Python
 *    reference. Two of them are reachable from here — half-up versus half-to-even rounding, and a
 *    float multiplication that truncates — and both become regression tests below. The exponent
 *    cases (`String(1e-7)` is `"1e-7"`, which is not a decimal string) are the third.
 */

import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../src/errors.js";
import type { Candle, Candles } from "../../src/models/order.js";
import { expandExponent, mapCandle, mapCandles } from "../../src/rest/candles.js";
import type { MappedCandle } from "../../src/rest/candles.js";
import { parseDecimal } from "../../src/util/decimal.js";

/* ---------------------------------------------------------------------------------------------- */
/* Fixture                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A BTC-shaped hour candle. The magnitudes matter: base volume is ~12.4 BTC and quote volume is
 * ~778 000 USDC, four orders of magnitude apart, so a `v`/`V` swap is impossible to miss.
 *
 * `C`/`H`/`L`/`O` are absent, exactly as they were on the live BTC response
 * (`docs/spec/05-rest-api.md` §10.6) — they are a secondary index series, not the traded one.
 */
const BTC_HOUR: Candle = {
  t: 1_733_011_200_000,
  o: 62_500.1,
  h: 62_940.7,
  l: 62_310.25,
  c: 62_880.5,
  v: 12.4386,
  V: 778_431.92,
  i: 60,
};

/* ---------------------------------------------------------------------------------------------- */
/* Key mapping                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

describe("mapCandle", () => {
  test("lowercase `v` is base volume and uppercase `V` is quote volume", () => {
    const mapped: MappedCandle = mapCandle(BTC_HOUR);
    expect(mapped.baseVolume).toBe("12.4386");
    expect(mapped.quoteVolume).toBe("778431.92");
    // Stated the other way round as well, so the intent survives a careless "fix".
    expect(mapped.baseVolume).not.toBe("778431.92");
    expect(mapped.quoteVolume).not.toBe("12.4386");
  });

  test("the OHLC letters map to their readable names", () => {
    const mapped: MappedCandle = mapCandle(BTC_HOUR);
    expect(mapped.open).toBe("62500.1");
    expect(mapped.high).toBe("62940.7");
    expect(mapped.low).toBe("62310.25");
    // `Candle.c` is the close price. `Candles.c`, one level up, is the array. Both are correct.
    expect(mapped.close).toBe("62880.5");
  });

  test("time and interval pass through as numbers, which D7 permits for a clock and a count", () => {
    const mapped: MappedCandle = mapCandle(BTC_HOUR);
    expect(mapped.time).toBe(1_733_011_200_000);
    expect(mapped.interval).toBe(60);
  });

  test("every OHLCV field is a string — D7, and ARCHITECTURE §6.6 is superseded", () => {
    const mapped: MappedCandle = mapCandle(BTC_HOUR);
    for (const key of ["open", "high", "low", "close", "baseVolume", "quoteVolume"] as const) {
      expect(typeof mapped[key]).toBe("string");
    }
    expect(typeof mapped.time).toBe("number");
    expect(typeof mapped.interval).toBe("number");
  });

  test("an absent key means zero, because the server omits zero-valued fields", () => {
    const mapped: MappedCandle = mapCandle({});
    expect(mapped).toEqual({
      time: 0,
      open: "0",
      high: "0",
      low: "0",
      close: "0",
      baseVolume: "0",
      quoteVolume: "0",
      interval: 0,
    });
  });

  test("the secondary index series C/H/L/O is ignored entirely", () => {
    const withIndex: Candle = { ...BTC_HOUR, C: 1, H: 2, L: 3, O: 4 };
    expect(mapCandle(withIndex)).toEqual(mapCandle(BTC_HOUR));
    expect(Object.keys(mapCandle(withIndex)).sort()).toEqual([
      "baseVolume",
      "close",
      "high",
      "interval",
      "low",
      "open",
      "quoteVolume",
      "time",
    ]);
  });

  test("a non-finite value is refused rather than rendered as a fabricated price", () => {
    expect(() => mapCandle({ ...BTC_HOUR, o: Number.NaN })).toThrow(LighterValidationError);
    expect(() => mapCandle({ ...BTC_HOUR, V: Number.POSITIVE_INFINITY })).toThrow(
      /not a finite value/,
    );
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Precision                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

describe("the conversion adds no error of its own", () => {
  test("no output ever carries exponent notation", () => {
    const extremes: Candle = {
      t: 1,
      o: 1e-7,
      h: 1e21,
      l: 5e-324,
      c: 1.7976931348623157e308,
      v: 1.5e-7,
      V: -2.5e-8,
      i: 1,
    };
    const mapped: MappedCandle = mapCandle(extremes);
    for (const key of ["open", "high", "low", "close", "baseVolume", "quoteVolume"] as const) {
      expect(mapped[key]).not.toMatch(/[eE]/);
      // And it is a decimal string a strict parser accepts — the parser in util/decimal.ts
      // rejects exponent form, `NaN`, `+1`, `.5` and `5.` by construction.
      expect(() => parseDecimal(mapped[key])).not.toThrow();
    }
    expect(mapped.open).toBe("0.0000001");
    expect(mapped.baseVolume).toBe("0.00000015");
    expect(mapped.quoteVolume).toBe("-0.000000025");
    expect(mapped.high).toBe("1" + "0".repeat(21));
  });

  test("§9.1 — a half is neither rounded up nor rounded to even; it is preserved", () => {
    // Python's `round(2500.5)` is 2500; `Math.round(2500.5)` is 2501. Both are wrong answers to a
    // question nobody asked: the value is carried through exactly.
    expect(mapCandle({ o: 2500.5 }).open).toBe("2500.5");
    expect(mapCandle({ o: 2501.5 }).open).toBe("2501.5");
    expect(mapCandle({ o: -0.5 }).open).toBe("-0.5");
  });

  test("§9.2 — no float multiplication is performed, so 8.2 stays 8.2", () => {
    // `int(8.2 * 1e6)` is 8199999 in the reference. Nothing here multiplies.
    expect(mapCandle({ v: 8.2 }).baseVolume).toBe("8.2");
    expect(mapCandle({ v: 0.1 + 0.2 }).baseVolume).toBe("0.30000000000000004");
  });

  test("§9.3 — the decimal point is never stripped, so scale is preserved", () => {
    // `int("2500.1".replace(".", ""))` is 25001, off by 100× at two decimals.
    expect(mapCandle({ o: 2500.1 }).open).toBe("2500.1");
  });

  test("signed zero renders as `0`, not `-0`", () => {
    expect(mapCandle({ o: -0, v: 0 }).open).toBe("0");
    expect(mapCandle({ v: 0 }).baseVolume).toBe("0");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Exponent expansion                                                                               */
/* ---------------------------------------------------------------------------------------------- */

describe("expandExponent", () => {
  test("leaves positional notation untouched", () => {
    for (const s of ["0", "1", "-1", "62500.1", "0.00001", "123456789012345680000"]) {
      expect(expandExponent(s)).toBe(s);
    }
  });

  test("expands both directions", () => {
    expect(expandExponent("1e-7")).toBe("0.0000001");
    expect(expandExponent("1.5e-7")).toBe("0.00000015");
    expect(expandExponent("-2.5e-8")).toBe("-0.000000025");
    expect(expandExponent("1e+21")).toBe("1000000000000000000000");
    expect(expandExponent("1.234e+5")).toBe("123400");
    expect(expandExponent("1.2345e+2")).toBe("123.45");
    expect(expandExponent("5e-324")).toBe("0." + "0".repeat(323) + "5");
  });

  test("round-trips every value it is given, across the whole double range", () => {
    const samples: number[] = [
      1e-7, 1.5e-7, 9.999999e-8, 5e-324, 2.2250738585072014e-308, 1e21, 1e100,
      1.7976931348623157e308, 0.1 + 0.2, 1 / 3, Math.PI, -1e-7, -1e21, 6.02e23,
    ];
    for (let i: number = 0; i < 2000; i += 1) {
      // A spread of exponents, so the sample set is not clustered around 1.
      const exponent: number = Math.floor(Math.random() * 620) - 320;
      const candidate: number = Math.random() * 10 ** exponent * (i % 2 === 0 ? 1 : -1);
      if (Number.isFinite(candidate)) samples.push(candidate);
    }
    for (const n of samples) {
      const expanded: string = expandExponent(String(n));
      expect(expanded).not.toMatch(/[eE]/);
      expect(() => parseDecimal(expanded)).not.toThrow();
      // The strongest available statement: the decimal string reads back as the identical double.
      expect(Number(expanded)).toBe(n);
    }
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The envelope                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

describe("mapCandles", () => {
  test("maps the `c` array — which is the candles, not the close price", () => {
    const envelope: Candles = { code: 200, r: "1h", c: [BTC_HOUR, { ...BTC_HOUR, c: 63_000 }] };
    const mapped: MappedCandle[] = mapCandles(envelope);
    expect(mapped.length).toBe(2);
    expect(mapped[0]?.close).toBe("62880.5");
    expect(mapped[1]?.close).toBe("63000");
  });

  test("an absent `c` array yields an empty list, not a crash", () => {
    expect(mapCandles({ code: 200, r: "1h" })).toEqual([]);
    expect(mapCandles({ code: 200 })).toEqual([]);
  });

  test("an explicitly empty array yields an empty list", () => {
    expect(mapCandles({ code: 200, r: "1h", c: [] })).toEqual([]);
  });

  test("the envelope's own fields are not folded into the candles", () => {
    const mapped: MappedCandle[] = mapCandles({ code: 200, r: "1h", c: [BTC_HOUR] });
    expect(Object.keys(mapped[0] ?? {})).not.toContain("r");
    expect(Object.keys(mapped[0] ?? {})).not.toContain("code");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Hygiene                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

describe("hygiene", () => {
  function candlesSource(): Promise<string> {
    return Bun.file(new URL("../../src/rest/candles.ts", import.meta.url).pathname).text();
  }

  test("the money path contains no float rounding or float parsing (D7)", async () => {
    const source: string = await candlesSource();
    for (const forbidden of ["toFixed", "Math.round", "parseFloat", "Number("]) {
      expect(source).not.toContain(forbidden);
    }
  });

  test("no Node built-in and no runtime dependency", async () => {
    const source: string = await candlesSource();
    for (const forbidden of ["node:", "Buffer", "process.", "require("]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
