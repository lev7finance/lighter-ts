/**
 * Candles, translated from the wire's single letters into names a reader can hold.
 *
 * `GET /api/v1/candles` is the one endpoint where faithfulness to the wire actively harms
 * ergonomics (`spec/05-rest-api.md` §10.6): its keys are single, **case-sensitive** letters, and two
 * of them differ only in case. Everywhere else in this SDK the public parameter and field names are
 * the wire's own `snake_case`; this is the documented exception, and it lives at the edge rather
 * than on the model so that `Candle` in `../models/order.js` stays checkable against a captured
 * response.
 *
 * Three things here are easy to get wrong, and two of them are silent:
 *
 * 1. **`v` is base volume; `V` is quote volume.** One letter apart, distinguished only by case.
 *    Swapping them changes every downstream volume by a factor of the price and raises no error
 *    anywhere. The regression test uses a fixture whose two volumes differ by orders of magnitude,
 *    so a swap cannot pass.
 * 2. **`Candles.c` is the array of candles; `Candle.c` is the close price.** Same key, two levels,
 *    different meanings. Both are correct on the wire and neither may be renamed.
 * 3. **`C`, `H`, `L`, `O` are a *secondary* (index) OHLC series and are absent when zero** —
 *    verified absent on BTC. They are not the primary series, and merging them into it would
 *    quietly replace traded prices with index prices. Nothing here reads them.
 *
 * ## Why the OHLCV fields are strings
 *
 * The wire sends them as JSON floats — the only place this API does not use decimal strings for
 * prices — so by the time the values arrive they are already binary64. That is a wire fact and not
 * something this module can undo. What it *can* do is refuse to make it worse: `docs/decisions.md`
 * **D7** requires that nothing monetary crosses this boundary as a `number`, and
 * `docs/ARCHITECTURE.md` §6.6, which types these six fields as `number`, is superseded by it — a
 * `number` here is an invitation for the consumer to do money arithmetic in floating point, which
 * is the precise defect ADR-15 exists to prevent.
 *
 * The conversion therefore adds no error of its own. `String(n)` is JavaScript's shortest
 * round-tripping representation: it emits the fewest digits that read back as the identical double,
 * so `String(0.1 + 0.2)` is `"0.30000000000000004"` and nothing is invented or discarded. What it
 * is *not* is always a decimal string — `String(1e-7)` is `"1e-7"` and `String(1e21)` is `"1e+21"`,
 * neither of which any decimal parser downstream will accept. {@link expandExponent} rewrites those
 * into positional form, losslessly and lexically, moving a decimal point through a digit string
 * with no numeric parser involved.
 *
 * Three things are deliberately absent from this file, and a test greps the source to keep them
 * absent: fixed-digit formatting (it asserts a precision the data does not have, and rounds to
 * reach it), any float re-parser (a second binary64 conversion of a value already converted), and
 * the half-up rounding built-in — which is half-up, while Python's `round()` is half-to-even. Those
 * two agree on odd halves and disagree on even ones (`docs/protocol-notes.md` §9.1), which is
 * exactly how a bad translation survives casual testing.
 *
 * `time` and `interval` stay `number`: they are a timestamp and a counter, which D7 permits, and
 * both are far inside the safe-integer range.
 */

import { LighterValidationError } from "../errors.js";
import type { EpochMs } from "../models/common.js";
import type { Candle, Candles } from "../models/order.js";

/* ---------------------------------------------------------------------------------------------- */
/* The readable shape                                                                               */
/* ---------------------------------------------------------------------------------------------- */

/**
 * One candle, with the wire's letters spelled out.
 *
 * Every field is present: the server omits a zero-valued key (`omitempty`), and an absent OHLCV key
 * means zero, so it is materialised as `"0"` rather than left `undefined`. That keeps the type flat
 * for charting code, which is the only consumer this shape exists for.
 */
export interface MappedCandle {
  /**
   * Wire `t`. Epoch **milliseconds**, the candle's **open** time — or its *end* time when the
   * request set `set_timestamp_to_end=true`. Nothing in the payload distinguishes the two; the
   * request does.
   */
  time: EpochMs;
  /** Wire `o`. Decimal string. */
  open: string;
  /** Wire `h`. Decimal string. */
  high: string;
  /** Wire `l`. Decimal string. */
  low: string;
  /** Wire `c` — the close price, *not* the candles array one level up. Decimal string. */
  close: string;
  /** Wire **`v`**, lowercase. Volume in the **base** asset. Decimal string. */
  baseVolume: string;
  /** Wire **`V`**, uppercase. Volume in the **quote** asset. Decimal string. */
  quoteVolume: string;
  /** Wire `i`. The interval/index counter, verbatim. */
  interval: number;
}

/* ---------------------------------------------------------------------------------------------- */
/* Mapping                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Map one wire candle to {@link MappedCandle}.
 *
 * Lossless and mechanical. `C`/`H`/`L`/`O` — the secondary index series — are ignored entirely.
 *
 * @throws {LighterValidationError} an OHLCV value is `NaN` or infinite (`code: "CANDLE_NOT_FINITE"`).
 *   There is no decimal string for either, and inventing one would put a fabricated price on a
 *   chart. This has never been observed live; it is here because the alternative is silent.
 */
export function mapCandle(c: Candle): MappedCandle {
  return {
    time: c.t ?? 0,
    open: decimalOf(c.o, "o"),
    high: decimalOf(c.h, "h"),
    low: decimalOf(c.l, "l"),
    close: decimalOf(c.c, "c"),
    // The two lines it is worth reading twice: lowercase `v` is base, uppercase `V` is quote.
    baseVolume: decimalOf(c.v, "v"),
    quoteVolume: decimalOf(c.V, "V"),
    interval: c.i ?? 0,
  };
}

/**
 * Map a whole `GET /api/v1/candles` envelope.
 *
 * `r` (the resolution echo) and `code` belong to the envelope and are not part of a candle; read
 * them off the response directly if you need them. An absent `c` array yields `[]` — the server
 * omits an empty collection rather than sending one.
 */
export function mapCandles(r: Candles): MappedCandle[] {
  const wire: readonly Candle[] | undefined = r.c;
  if (wire === undefined) return [];
  const out: MappedCandle[] = [];
  for (const candle of wire) out.push(mapCandle(candle));
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* Float → decimal string                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/** An absent OHLCV key means zero (`omitempty`), which is a real value and must be rendered. */
function decimalOf(value: number | undefined, key: string): string {
  if (value === undefined) return "0";
  if (!Number.isFinite(value)) {
    throw new LighterValidationError(
      "CANDLE_NOT_FINITE",
      `candle field "${key}" is not a finite value (${String(value)}); it has no decimal ` +
        `representation and cannot be rendered as a price`,
      { field: key },
    );
  }
  return expandExponent(String(value));
}

/**
 * Rewrite JavaScript's exponent notation into positional decimal form.
 *
 * Purely lexical: the input is a digit string with a decimal point and an exponent, and the output
 * is the same digit string with the point moved. No numeric parser is involved at any step, so the
 * transformation cannot round, cannot overflow and cannot reorder digits.
 *
 * `"1e-7"` → `"0.0000001"`, `"1.5e-7"` → `"0.00000015"`, `"1e+21"` → `"1000000000000000000000"`,
 * `"-2.5e-8"` → `"-0.000000025"`. A string with no exponent is returned unchanged, which is the
 * overwhelmingly common case — `String` only reaches exponent form below 1e-6 or at or above 1e21.
 *
 * Exported because it is the part worth testing directly.
 */
export function expandExponent(s: string): string {
  const marker: number = s.search(/[eE]/);
  if (marker < 0) return s;

  let exponentText: string = s.slice(marker + 1);
  let exponentNegative: boolean = false;
  if (exponentText.startsWith("-")) {
    exponentNegative = true;
    exponentText = exponentText.slice(1);
  } else if (exponentText.startsWith("+")) {
    exponentText = exponentText.slice(1);
  }
  const exponent: number = digitsToInt(exponentText);

  let mantissa: string = s.slice(0, marker);
  let sign: string = "";
  if (mantissa.startsWith("-")) {
    sign = "-";
    mantissa = mantissa.slice(1);
  }

  const dot: number = mantissa.indexOf(".");
  const wholePart: string = dot < 0 ? mantissa : mantissa.slice(0, dot);
  const fractionPart: string = dot < 0 ? "" : mantissa.slice(dot + 1);
  const digits: string = wholePart + fractionPart;

  // Where the decimal point sits, counted in digits from the left, after the shift.
  const point: number = wholePart.length + (exponentNegative ? -exponent : exponent);

  let body: string;
  if (point <= 0) {
    body = "0." + "0".repeat(-point) + digits;
  } else if (point >= digits.length) {
    body = digits + "0".repeat(point - digits.length);
  } else {
    body = digits.slice(0, point) + "." + digits.slice(point);
  }

  // `-0` and its scaled forms render as `"0"`: a signed zero is not a price, and no consumer
  // should have to strip the sign.
  if (!/[1-9]/.test(digits)) return "0";
  return sign + body;
}

/**
 * A run of ASCII digits as an integer.
 *
 * Hand-written rather than borrowed so that no numeric string parser appears anywhere in this file
 * — the point of the exercise is that the money path contains none. The input is an exponent
 * produced by `String` on a finite double, so it is at most three digits and the arithmetic is
 * exact in any case.
 */
function digitsToInt(digits: string): number {
  let value: number = 0;
  for (let i: number = 0; i < digits.length; i += 1) {
    value = value * 10 + (digits.charCodeAt(i) - 0x30);
  }
  return value;
}
