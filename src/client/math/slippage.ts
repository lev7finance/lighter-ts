/**
 * The slippage bound: the worst price a market order is allowed to be filled at.
 *
 * This is a two-line formula and the most dangerous arithmetic in the SDK, because every way of
 * getting it wrong produces a *valid order at a worse price* rather than an error.
 *
 * ## The rounding rule
 *
 * The normative invariant is **rounding never loosens slippage protection**
 * (`docs/decisions.md` D7, `docs/protocol-notes.md` §9). A buy's acceptable price is a *maximum*,
 * so rounding it up permits the user to pay more than the exact bound allows.
 * `docs/spec/07-high-level-client.md` §3.2 and §3.5 give the formulas:
 *
 * ```
 * s = num/den
 * buy  (isAsk = false): acceptable = floor( ideal × (den + num) / den )     conservative
 * sell (isAsk = true ): acceptable = ceil ( ideal × (den − num) / den )     conservative
 * ```
 *
 * The invariant is enforced mechanically by a property test rather than by this comment: for a
 * seeded corpus the conservative bound is never more permissive than the exact rational bound on
 * either side.
 *
 * `aggressive` swaps the two directions. It trades a marginally worse price for fill probability at
 * the boundary tick, it is never the default, and it is at most one tick from the exact bound.
 *
 * ## What is not used
 *
 * The reference applies Python's `round()`, which is round-half-to-even. Translating that to the
 * JavaScript rounding built-in, which is half-up, changes the answer on every *even* half —
 * `round(2500.5)` is `2500` in Python and `2501` in JavaScript — while agreeing on every odd half,
 * so the mistranslation survives casual testing (`docs/protocol-notes.md` §9, hazard 1). Neither
 * rule is a valid slippage bound, because neither knows which direction protects the user. Nothing
 * here rounds to nearest, and nothing here touches a binary floating-point value: the bound is a
 * single exact integer division under an explicitly named direction.
 */

import { LighterMathError, LighterValidationError } from "../../errors.js";
import { divRound, parseDecimal, type ParsedDecimal, type RoundingMode } from "../../util/decimal.js";
import { type Fraction, reduceFraction } from "./book.js";

/* -------------------------------------------------------------------------------------------- */
/* Shapes                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * Which way a bound rounds when it lands between two ticks.
 *
 * - `conservative` — toward the user's protection. The default, everywhere.
 * - `aggressive` — toward fill probability, by at most one tick.
 */
export type SlippageMode = "conservative" | "aggressive";

/** `MaxOrderPrice`. A price of `0` is `NilOrderPrice`, which is a different instruction entirely. */
export const MAX_ORDER_PRICE: bigint = 2n ** 32n - 1n;

/** `MinOrderPrice`. */
export const MIN_ORDER_PRICE: bigint = 1n;

/* -------------------------------------------------------------------------------------------- */
/* Parsing                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * Three spellings of one fraction, parsed lexically into exact lowest terms.
 *
 * ```
 * "0.005"  → 1/200      a bare fraction
 * "0.5%"   → 1/200      a percentage
 * "50bps"  → 1/200      basis points
 * ```
 *
 * The suffix is matched case-insensitively; nothing else is accepted. Exponent notation, a leading
 * `+`, a bare `.5`, and surrounding whitespace are all rejected, because each is a sign that the
 * value reached here through a numeric parser instead of from a human or a config file.
 *
 * The domain is `[0, 1]`. A negative slippage would invert the bound into a limit order on the
 * wrong side, and a slippage above `1` would drive a sell's bound negative; both are rejected
 * rather than clamped, because in either case the caller meant something this function cannot
 * guess.
 */
export function parseSlippage(s: string): Fraction {
  if (typeof s !== "string") {
    throw new LighterValidationError("SLIPPAGE_INVALID", `slippage must be a string, got ${typeof s}`);
  }
  const matched: RegExpExecArray | null = /^([0-9]+(?:\.[0-9]+)?)(%|bps)?$/i.exec(s);
  if (matched === null) {
    throw new LighterValidationError(
      "SLIPPAGE_INVALID",
      `slippage must look like "0.005", "0.5%" or "50bps", got ${JSON.stringify(s)}`,
    );
  }
  const digits: string = matched[1] ?? "";
  const suffix: string = (matched[2] ?? "").toLowerCase();
  const parsed: ParsedDecimal = parseDecimal(digits);
  const unit: bigint = suffix === "%" ? 100n : suffix === "bps" ? 10_000n : 1n;
  return assertFraction(reduceFraction(parsed.unscaled, 10n ** BigInt(parsed.scale) * unit), s);
}

/* -------------------------------------------------------------------------------------------- */
/* The bound                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * The worst price an order may be filled at, given an ideal price and a maximum slippage.
 *
 * `idealPrice` is an integer at the market's price precision — the best price on the opposing side,
 * or one the caller supplied. `isAsk` describes the *order*: `true` is a sell, whose bound is a
 * floor price, and `false` is a buy, whose bound is a ceiling price.
 *
 * The result is clamped above at `MaxOrderPrice`, which can only tighten a buy's cap and so is
 * always safe. It is **not** clamped below: a sell whose bound rounds to `0` would be submitted as
 * `NilOrderPrice` — "no price", not "any price" — so it raises {@link LighterMathError}
 * `NOT_REPRESENTABLE` instead.
 */
export function slippageBound(
  idealPrice: bigint,
  slippage: string | Fraction,
  isAsk: boolean,
  mode: SlippageMode = "conservative",
): bigint {
  if (typeof idealPrice !== "bigint" || idealPrice < MIN_ORDER_PRICE) {
    throw new LighterValidationError(
      "PRICE_TOO_LOW",
      `ideal price must be a positive integer at the market's price precision, got ${String(idealPrice)}`,
      { bound: MIN_ORDER_PRICE },
    );
  }
  if (idealPrice > MAX_ORDER_PRICE) {
    throw new LighterValidationError(
      "PRICE_TOO_HIGH",
      `ideal price ${idealPrice.toString()} exceeds MaxOrderPrice`,
      { bound: MAX_ORDER_PRICE },
    );
  }
  const fraction: Fraction =
    typeof slippage === "string" ? parseSlippage(slippage) : assertFraction(slippage, "slippage");

  // A buy pays more as slippage grows; a sell accepts less.
  const numerator: bigint = isAsk
    ? idealPrice * (fraction.den - fraction.num)
    : idealPrice * (fraction.den + fraction.num);
  const direction: RoundingMode = roundingFor(isAsk, mode);
  const bound: bigint = divRound(numerator, fraction.den, direction);

  if (bound < MIN_ORDER_PRICE) {
    throw new LighterMathError(
      "NOT_REPRESENTABLE",
      `a ${isAsk ? "sell" : "buy"} bound of ${bound.toString()} is below MinOrderPrice; ` +
        `slippage ${fraction.num.toString()}/${fraction.den.toString()} against an ideal price of ` +
        `${idealPrice.toString()} leaves no representable price`,
    );
  }
  return bound > MAX_ORDER_PRICE ? MAX_ORDER_PRICE : bound;
}

/**
 * The rounding direction for one side and mode, named rather than inlined.
 *
 * Conservative tightens: a buy's ceiling rounds down, a sell's floor rounds up. This is the single
 * place the resolved documentation conflict is expressed, so a test can assert on it directly.
 */
export function roundingFor(isAsk: boolean, mode: SlippageMode = "conservative"): RoundingMode {
  if (mode !== "conservative" && mode !== "aggressive") {
    throw new LighterValidationError("SLIPPAGE_MODE_INVALID", `unknown slippage mode ${String(mode)}`);
  }
  const conservative: boolean = mode === "conservative";
  return isAsk === conservative ? "CEIL" : "FLOOR";
}

/** A supplied fraction has to be a real one in `[0, 1]`, in lowest terms, before it is trusted. */
function assertFraction(f: Fraction, what: string): Fraction {
  if (typeof f.num !== "bigint" || typeof f.den !== "bigint") {
    throw new LighterValidationError("SLIPPAGE_INVALID", `${what}: num and den must both be bigint`);
  }
  if (f.den <= 0n) {
    throw new LighterValidationError("SLIPPAGE_INVALID", `${what}: denominator must be positive`);
  }
  if (f.num < 0n) {
    throw new LighterValidationError(
      "SLIPPAGE_OUT_OF_RANGE",
      `${what}: a negative slippage would invert the bound`,
    );
  }
  if (f.num > f.den) {
    throw new LighterValidationError(
      "SLIPPAGE_OUT_OF_RANGE",
      `${what}: slippage above 100% is not a bound this function can express`,
    );
  }
  return reduceFraction(f.num, f.den);
}
