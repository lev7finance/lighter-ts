/**
 * Market metadata and book fixtures shared by the order-math tests.
 *
 * Everything that can come from the golden capture does. `test/fixtures/rest/responses.json` is a
 * real `mainnet.zklighter.elliot.ai` capture taken in wave 0 with no SDK code involved, and both
 * the market records and the `orderBookOrders` body below are its bytes.
 *
 * Two derivations are labelled SYNTHETIC, and each changes exactly one thing:
 *
 * 1. The captured `orderBookOrders` body is market 1 (BTC), which the capture's truncated
 *    `/orderBooks` list does not contain. Its prices carry one decimal and its sizes five, so the
 *    market it is walked against declares `priceDecimals = 1`, `sizeDecimals = 5`,
 *    `quoteDecimals = 6` — consistent with the captured strings and with the cross-scale invariant.
 * 2. `minQuoteAmount` is set to zero on one market so a sub-dollar order can be sized. Every live
 *    market in the capture has a $10 floor, which would mask the arithmetic under test.
 */

import { readFileSync } from "node:fs";

import type { MarketInfo } from "../../../src/client/markets.js";
import { toMarketInfo } from "../../../src/client/markets.js";
import type { OrderBookOrders } from "../../../src/models/order.js";
import { goldenMarket } from "../harness.js";

interface FixtureCase {
  readonly body: unknown;
}

/** DIA: `sizeDecimals = 4`, `priceDecimals = 2`, `quoteDecimals = 6`. Captured, unmodified. */
export function diaMarket(): MarketInfo {
  return toMarketInfo(goldenMarket("DIA"));
}

/** RAIL: `sizeDecimals = 2`, `priceDecimals = 4`. Captured, unmodified. */
export function railMarket(): MarketInfo {
  return toMarketInfo(goldenMarket("RAIL"));
}

/** SYNTHETIC: DIA with no minimum notional, so a small order can be sized without tripping the floor. */
export function noMinimumMarket(): MarketInfo {
  return { ...diaMarket(), minQuoteAmount: "0.000000", minBaseAmount: "0.0000" };
}

/** SYNTHETIC: the market the captured `orderBookOrders` body belongs to (market 1, BTC). */
export function btcMarket(): MarketInfo {
  return {
    ...diaMarket(),
    marketId: 1,
    symbol: "BTC",
    sizeDecimals: 5,
    priceDecimals: 1,
    quoteDecimals: 6,
    minBaseAmount: "0.00000",
    minQuoteAmount: "0.000000",
  };
}

/** SYNTHETIC: DIA with the cross-scale invariant broken by one decimal and nothing else changed. */
export function crossScaleViolatorMarket(): MarketInfo {
  const base: MarketInfo = diaMarket();
  return { ...base, quoteDecimals: base.quoteDecimals + 1, quoteSizingSupported: false };
}

/** SYNTHETIC: a perps market whose declared maximum leverage is 50× (`minInitialMarginFraction = 200`). */
export function perpsMarket(minInitialMarginFraction: number = 200): MarketInfo {
  return { ...diaMarket(), perps: { minInitialMarginFraction, defaultInitialMarginFraction: 500 } };
}

/** The captured `GET /api/v1/orderBookOrders?market_id=1&limit=5` body, verbatim. */
export function goldenOrderBookOrders(): OrderBookOrders {
  return fixtureBody("orderBookOrders") as OrderBookOrders;
}

function fixtureBody(name: string): unknown {
  const cases: Record<string, FixtureCase> = fixtures.cases;
  const found: FixtureCase | undefined = cases[name];
  if (found === undefined) throw new Error(`no fixture named ${name}`);
  return found.body;
}

const fixtures = JSON.parse(
  readFileSync(new URL("../../fixtures/rest/responses.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, FixtureCase> };

/* ---------------------------------------------------------------------------------------------- */
/* Assertions                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/** Run `body`, and return the error it threw. Fails loudly when it did not throw at all. */
export function caught(body: () => unknown): unknown {
  try {
    body();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the call to throw, and it returned");
}

/** The `code` of whatever `body` threw, for a `toBe` comparison that names the code in the diff. */
export function thrownCode(body: () => unknown): unknown {
  const error: unknown = caught(body);
  if (error instanceof Error && "code" in error) return (error as { code: unknown }).code;
  return error;
}

/** Deep-freeze, so a mutation of an argument is a `TypeError` in strict mode rather than a silence. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}
