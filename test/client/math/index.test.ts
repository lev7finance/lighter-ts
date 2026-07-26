/**
 * The module-local barrel, the purity contract, and the source-level gates.
 *
 * The last two are the ones worth reading. This layer decides what price and size an order is
 * actually submitted at, so "pure over a snapshot" and "no binary float anywhere near money" are
 * properties that have to be checked mechanically — a comment saying so is worth nothing after the
 * third person edits the file.
 */

import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import * as math from "../../../src/client/math/index.js";
import type { BookSnapshot } from "../../../src/client/math/index.js";
import type { MarketInfo } from "../../../src/client/markets.js";
import type { OrderBookOrders } from "../../../src/models/order.js";
import { btcMarket, deepFreeze, goldenOrderBookOrders, noMinimumMarket, perpsMarket } from "./fixtures.js";

describe("the barrel", () => {
  test("re-exports every name this unit owes its callers", () => {
      for (const name of [
        "bookFromRestOrders",
        "bookFromLevels",
        "bestPrice",
        "potentialExecutionPrice",
        "reduceFraction",
        "parseSlippage",
        "slippageBound",
        "roundingFor",
        "quoteToBase",
        "baseOrderIfSlippage",
        "leverageToImf",
        "MARGIN_FRACTION_TICK",
        "MAX_ORDER_PRICE",
        "MIN_ORDER_PRICE",
        "MAX_ORDER_BASE_AMOUNT",
        "MIN_ORDER_BASE_AMOUNT",
    ]) {
      expect(name in math).toBe(true);
    }
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Purity                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

describe("purity", () => {
  const market: MarketInfo = deepFreeze(noMinimumMarket());
  const perps: MarketInfo = deepFreeze(perpsMarket());
  const restOrders: OrderBookOrders = deepFreeze(goldenOrderBookOrders());
  const btc: MarketInfo = deepFreeze(btcMarket());
  const levels = deepFreeze({
    bids: [{ price: "0.99", size: "5.0000" }],
    asks: [
      { price: "1.00", size: "5.0000" },
      { price: "1.01", size: "5.0000" },
    ],
  });
  const book: BookSnapshot = deepFreeze(math.bookFromLevels(levels.bids, levels.asks, market));

  /** Every exported entry point, called against frozen inputs. */
  const calls: Record<string, () => unknown> = {
    bookFromRestOrders: (): unknown => math.bookFromRestOrders(restOrders, btc),
    bookFromLevels: (): unknown => math.bookFromLevels(levels.bids, levels.asks, market),
    bestPrice: (): unknown => math.bestPrice(book, false),
    potentialExecutionPrice: (): unknown => math.potentialExecutionPrice(book, 20_000n, false, false),
    reduceFraction: (): unknown => math.reduceFraction(10_000n, 4_000n),
    parseSlippage: (): unknown => math.parseSlippage("0.5%"),
    slippageBound: (): unknown => math.slippageBound(100n, "0.5%", false),
    roundingFor: (): unknown => math.roundingFor(true),
    quoteToBase: (): unknown => math.quoteToBase(book, market, "1.5", false, "1%"),
    baseOrderIfSlippage: (): unknown => math.baseOrderIfSlippage(book, market, 10_000n, false, "1%"),
    leverageToImf: (): unknown => math.leverageToImf({ leverage: "3" }, perps),
  };

  test("every function returns the same answer when called twice on a frozen input", () => {
    const names: readonly string[] = Object.keys(calls);
    expect(names.length).toBe(11);
    for (const name of names) {
      const call: (() => unknown) | undefined = calls[name];
      if (call === undefined) throw new Error(`missing call for ${name}`);
      expect(call()).toEqual(call());
    }
  });

  test("order of calls does not matter — nothing here holds state between them", () => {
    const forwards: unknown[] = Object.keys(calls).map((n: string): unknown => calls[n]?.());
    const backwards: unknown[] = Object.keys(calls)
      .reverse()
      .map((n: string): unknown => calls[n]?.())
      .reverse();
    expect(forwards).toEqual(backwards);
  });

  test("no argument is mutated: the frozen inputs survive every call", () => {
    const before: string = shapeOf({ market, perps, restOrders, btc, levels, book });
    for (const call of Object.values(calls)) call();
    expect(shapeOf({ market, perps, restOrders, btc, levels, book })).toBe(before);
  });
});

/** A stable, `bigint`-safe rendering of a value, for before/after comparison. */
function shapeOf(value: unknown): string {
  return JSON.stringify(value, (_key: string, v: unknown): unknown =>
    typeof v === "bigint" ? `${v.toString()}n` : v,
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Source-level gates                                                                               */
/* ---------------------------------------------------------------------------------------------- */

describe("source gates", () => {
  const directory: URL = new URL("../../../src/client/math/", import.meta.url);
  const sources: readonly (readonly [string, string])[] = readdirSync(directory)
    .filter((name: string): boolean => name.endsWith(".ts"))
    .map((name: string): readonly [string, string] => [
      name,
      readFileSync(new URL(name, directory), "utf8"),
    ]);

  test("all five files are present", () => {
    expect(sources.map(([name]: readonly [string, string]): string => name).sort()).toEqual([
      "book.ts",
      "index.ts",
      "leverage.ts",
      "quote.ts",
      "slippage.ts",
    ]);
  });

  test("no float arithmetic and no numeric coercion on a monetary path", () => {
    const banned: RegExp = /Math\.round|Math\.floor|Math\.ceil|parseFloat|Number\(|1e6|toFixed/;
    for (const [name, source] of sources) {
      expect([name, banned.test(source)]).toEqual([name, false]);
    }
  });

  test("no price, size, notional or fee is typed as a JavaScript number", () => {
    const banned: RegExp = /(price|amount|size|notional|quote|fee)[A-Za-z]*\??: *number/;
    for (const [name, source] of sources) {
      expect([name, banned.test(source)]).toEqual([name, false]);
    }
  });

  test("no I/O, no clock, no host built-ins", () => {
    const banned: RegExp = /from ['"]node:|require\(|\bBuffer\b|\bprocess\.|fetch\(|Date\.now/;
    for (const [name, source] of sources) {
      expect([name, banned.test(source)]).toEqual([name, false]);
    }
  });

  test("nothing at module scope but constants and functions", () => {
    // `let`/`var` at the top level of any of these files would be shared mutable state, which the
    // suite would only notice as a flake once another file runs first.
    const moduleScopedBinding: RegExp = /^(?:let|var) /m;
    for (const [name, source] of sources) {
      expect([name, moduleScopedBinding.test(source)]).toEqual([name, false]);
    }
  });
});
