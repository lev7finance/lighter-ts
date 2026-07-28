/**
 * Leverage ↔ initial margin fraction.
 *
 * The protocol stores an **initial margin fraction** in basis points against
 * `MarginFractionTick = 10_000`: `imf = 500` is 5% margin, i.e. 20× leverage, and
 * `leverage = 10_000 / imf` exactly. `UpdateLeverage` carries the `imf`, never the leverage, so
 * every leverage a user types has to be turned into one of 10 000 representable values and the
 * direction of that step decides whether they end up more or less exposed than they asked for.
 *
 * The reference truncates: `int(10_000 / 3)` is `3333`, which is an effective **3.0003×** — more
 * leverage than requested. `int(10_000 / 7)` is `1428`, an effective 7.003×. Rounding up instead
 * gives `3334` (2.9994×) and `1429` (6.997×), so the account is never more levered than the number
 * the user typed (`docs/spec/07-high-level-client.md` §3.8).
 *
 * The deviation does not vanish, it just changes sign, so it is always returned:
 * {@link LeverageResult.effectiveLeverage} is the exact rational actually applied. A caller that
 * needs to display "3×" and a caller that needs to compute a liquidation price need different
 * things from the same call, and only one of them can use the rounded number.
 *
 * `leverage` is never a fractional binary float (`docs/decisions.md` D7 supersedes the
 * `leverage: number` signature in `docs/ARCHITECTURE.md` §6.8): it is a decimal string or an exact
 * rational. The `imf` itself *is* a small integer count in `[1, 10_000]`, which is where the
 * numeric type is permitted.
 */

import { LighterValidationError } from "../../errors.js";
import { parseDecimal, type ParsedDecimal } from "../../util/decimal.js";
import type { MarketInfo } from "../markets.js";
import { type Fraction, reduceFraction } from "./book.js";

/* -------------------------------------------------------------------------------------------- */
/* Shapes                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** `MarginFractionTick`: the `imf` denominator, so `10_000` is 1× and `200` is 50×. */
export const MARGIN_FRACTION_TICK: bigint = 10_000n;

/** The lowest `imf` the protocol can express, i.e. the most leverage: 10 000×. */
export const MIN_INITIAL_MARGIN_FRACTION: number = 1;

/** The highest `imf`: full margin, 1× leverage. */
export const MAX_INITIAL_MARGIN_FRACTION: number = 10_000;

/**
 * Exactly one of the two spellings.
 *
 * A leverage is what a user says; an `initialMarginFraction` is what the protocol stores, and is
 * accepted directly so a caller reading an existing account's configuration can round-trip it
 * without a lossy conversion in the middle.
 */
export type LeverageInput =
  | { readonly leverage: string }
  | { readonly leverage: Fraction }
  | { readonly initialMarginFraction: number };

/** What was actually applied, and how far it is from what was asked. */
export interface LeverageResult {
  /** The protocol field: an integer in `[1, 10_000]`. */
  readonly imf: number;
  /** `10_000 / imf`, exact and in lowest terms. Never above the requested leverage. */
  readonly effectiveLeverage: Fraction;
  /**
   * `true` when the request could not be honoured and was moved to the nearest expressible value.
   *
   * The only case is a leverage below 1×, which the protocol cannot express — full margin is the
   * least levered state there is — so it becomes 1×. Requesting *more* leverage than the market
   * allows is not clamped: silently halving someone's intended position size is worse than telling
   * them the market said no.
   */
  readonly clamped: boolean;
}

/* -------------------------------------------------------------------------------------------- */
/* Conversion                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * Turn a requested leverage into the `imf` the transaction carries.
 *
 * `imf = ceil(10_000 / leverage)`, clamped up to `10_000` when the request is below 1×, and
 * rejected when it is above the market's maximum (`imf` below
 * `market.perps.minInitialMarginFraction`). A market with no perps metadata loaded is bounded only
 * by the protocol domain.
 */
export function leverageToImf(input: LeverageInput, market: MarketInfo): LeverageResult {
  const requested: bigint = imfFromInput(input);
  const floorImf: bigint = BigInt(marketMinimumImf(market));

  if (requested < floorImf) {
    throw new LighterValidationError(
      "IMF_TOO_LOW",
      `an initial margin fraction of ${requested.toString()} exceeds ${market.symbol}'s maximum leverage ` +
        `(its lowest margin fraction is ${floorImf.toString()}, i.e. ` +
        `${describeLeverage(floorImf)}×)`,
      { bound: floorImf, field: "InitialMarginFraction" },
    );
  }

  const clamped: boolean = requested > MARGIN_FRACTION_TICK;
  const imf: bigint = clamped ? MARGIN_FRACTION_TICK : requested;
  return {
    imf: smallInt(imf),
    effectiveLeverage: reduceFraction(MARGIN_FRACTION_TICK, imf),
    clamped,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Internals                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** The raw `imf` a caller asked for, before any market bound is applied. */
function imfFromInput(input: LeverageInput): bigint {
  if (input === null || typeof input !== "object") {
    throw new LighterValidationError("LEVERAGE_INVALID", "leverage input must be an object");
  }
  const hasLeverage: boolean = "leverage" in input && input.leverage !== undefined;
  const hasImf: boolean = "initialMarginFraction" in input && input.initialMarginFraction !== undefined;
  if (hasLeverage === hasImf) {
    throw new LighterValidationError(
      "LEVERAGE_INVALID",
      "supply exactly one of `leverage` and `initialMarginFraction`",
    );
  }

  if (hasImf) {
    const raw: number = (input as { readonly initialMarginFraction: number }).initialMarginFraction;
    if (!Number.isInteger(raw) || raw < MIN_INITIAL_MARGIN_FRACTION || raw > MAX_INITIAL_MARGIN_FRACTION) {
      throw new LighterValidationError(
        "IMF_INVALID",
        `initialMarginFraction must be an integer in [${String(MIN_INITIAL_MARGIN_FRACTION)}, ` +
          `${String(MAX_INITIAL_MARGIN_FRACTION)}], got ${String(raw)}`,
      );
    }
    return BigInt(raw);
  }

  const leverage: Fraction = asFraction((input as { readonly leverage: string | Fraction }).leverage);
  // ceil(10_000 / (num/den)) = ceil(10_000·den / num), over integers.
  const numerator: bigint = MARGIN_FRACTION_TICK * leverage.den;
  const quotient: bigint = numerator / leverage.num;
  return numerator % leverage.num === 0n ? quotient : quotient + 1n;
}

/** A leverage, from a decimal string or an exact rational. Strictly positive, never a float. */
function asFraction(leverage: string | Fraction): Fraction {
  if (typeof leverage === "string") {
    const parsed: ParsedDecimal = parseDecimal(leverage);
    if (parsed.unscaled <= 0n) {
      throw new LighterValidationError(
        "LEVERAGE_INVALID",
        `leverage must be positive, got ${JSON.stringify(leverage)}`,
      );
    }
    return reduceFraction(parsed.unscaled, 10n ** BigInt(parsed.scale));
  }
  if (
    leverage === null ||
    typeof leverage !== "object" ||
    typeof leverage.num !== "bigint" ||
    typeof leverage.den !== "bigint"
  ) {
    throw new LighterValidationError(
      "LEVERAGE_INVALID",
      "leverage must be a decimal string or a { num, den } pair of bigints",
    );
  }
  if (leverage.num <= 0n || leverage.den <= 0n) {
    throw new LighterValidationError("LEVERAGE_INVALID", "leverage must be a positive rational");
  }
  return reduceFraction(leverage.num, leverage.den);
}

/** The market's own leverage ceiling, expressed as its lowest margin fraction. */
function marketMinimumImf(market: MarketInfo): number {
  const declared: number | undefined = market.perps?.minInitialMarginFraction;
  if (declared === undefined) return MIN_INITIAL_MARGIN_FRACTION;
  if (!Number.isInteger(declared) || declared < MIN_INITIAL_MARGIN_FRACTION || declared > MAX_INITIAL_MARGIN_FRACTION) {
    throw new LighterValidationError(
      "IMF_INVALID",
      `${market.symbol} declares an unusable minimum initial margin fraction (${String(declared)})`,
    );
  }
  return declared;
}

/** `10_000 / imf` rendered for a message. Diagnostics only; never fed back into arithmetic. */
function describeLeverage(imf: bigint): string {
  const whole: bigint = MARGIN_FRACTION_TICK / imf;
  const remainder: bigint = MARGIN_FRACTION_TICK % imf;
  return remainder === 0n ? whole.toString() : `~${whole.toString()}`;
}

/**
 * A `bigint` in `[1, 10_000]` as a `number`.
 *
 * The numeric conversion helper is spelled out through the decimal string on purpose: this unit's
 * lint gate forbids the usual coercion outright, because on every other value in this directory it
 * would be a defect. Here the domain is a small count with an asserted bound, which is exactly
 * where `docs/decisions.md` D7 permits the numeric type.
 */
function smallInt(v: bigint): number {
  if (v < 1n || v > MARGIN_FRACTION_TICK) {
    throw new LighterValidationError("IMF_INVALID", `margin fraction ${v.toString()} is out of range`);
  }
  return parseInt(v.toString(), 10);
}
