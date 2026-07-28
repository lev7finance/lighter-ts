/**
 * `src/client/markets.ts`.
 *
 * This is the layer that decides what magnitude an order is submitted at, so the tests are about
 * the four ways that can go wrong rather than about coverage:
 *
 * 1. a decimal exponent that is guessed instead of known,
 * 2. a quote-sized order on a market where `price + size !== quote`,
 * 3. a bare symbol resolved to the wrong one of two markets,
 * 4. a monetary string that has been through `Number` on the way in.
 *
 * Each of those is a wrong order rather than an error, which is why each of them is an error here.
 *
 * The evidence is `test/fixtures/rest/responses.json`; see `./harness.ts` for exactly which parts of
 * each body are captured and which are derived, and why.
 */

import { describe, expect, test } from "bun:test";

import type { Diagnostic } from "../../src/config/config.js";
import type { MarketInfo, MarketSnapshot } from "../../src/client/markets.js";
import { MarketRegistry, NIL_MARKET_INDEX, toMarketInfo } from "../../src/client/markets.js";
import { LighterConfigError } from "../../src/errors.js";
import type { OrderBook, OrderBookDetails, PerpsOrderBookDetail } from "../../src/models/market.js";
import {
  PATH_ASSET_DETAILS,
  PATH_ORDER_BOOKS,
  PATH_ORDER_BOOK_DETAILS,
  derivedCrossScaleViolator,
  derivedSpotMarket,
  fakeClock,
  fakeServer,
  goldenAssetDetails,
  goldenMarket,
  goldenMarkets,
  goldenOrderBooks,
  jsonResponse,
  orderBookDetailsBody,
  recordTimers,
} from "./harness.js";
import type { FakeServer } from "./harness.js";

interface Rig {
  readonly registry: MarketRegistry;
  readonly server: FakeServer;
  readonly diagnostics: Diagnostic[];
}

function rig(details: OrderBookDetails = orderBookDetailsBody(), ttlMs: number = 300_000): Rig {
  const diagnostics: Diagnostic[] = [];
  const server: FakeServer = fakeServer({
    [PATH_ORDER_BOOK_DETAILS]: (): Response => jsonResponse(details),
    [PATH_ORDER_BOOKS]: (): Response => jsonResponse(goldenOrderBooks()),
    [PATH_ASSET_DETAILS]: (): Response => jsonResponse(goldenAssetDetails()),
  });
  const registry: MarketRegistry = new MarketRegistry({
    rest: server.client,
    ttlMs,
    onDiagnostic: (d: Diagnostic): void => {
      diagnostics.push(d);
    },
  });
  return { registry, server, diagnostics };
}

/* ---------------------------------------------------------------------------------------------- */

describe("toMarketInfo", () => {
  test("carries the three exponents through unswapped", () => {
    // DIA has 4 size / 2 price decimals and RAIL has 2 / 4 — transposing them survives a test that
    // only ever looks at one market, so both are checked.
    for (const symbol of ["DIA", "RAIL"]) {
      const raw: OrderBook = goldenMarket(symbol);
      const info: MarketInfo = toMarketInfo(raw);
      expect(info.sizeDecimals).toBe(raw.supported_size_decimals as number);
      expect(info.priceDecimals).toBe(raw.supported_price_decimals as number);
      expect(info.quoteDecimals).toBe(raw.supported_quote_decimals as number);
    }
    expect(toMarketInfo(goldenMarket("DIA")).sizeDecimals).not.toBe(
      toMarketInfo(goldenMarket("RAIL")).sizeDecimals,
    );
  });

  test("every monetary field is the exact string the wire sent", () => {
    const raw: OrderBook = goldenMarket("RAIL");
    const info: MarketInfo = toMarketInfo(raw);
    expect(info.minBaseAmount).toBe(raw.min_base_amount as string);
    expect(info.minQuoteAmount).toBe(raw.min_quote_amount as string);
    expect(info.orderQuoteLimit).toBe(raw.order_quote_limit as string);
    expect(info.takerFee).toBe(raw.taker_fee as string);
    expect(info.makerFee).toBe(raw.maker_fee as string);
    expect(info.liquidationFee).toBe(raw.liquidation_fee as string);
    // Trailing zeros are the market's declared precision, not noise: "2.00" is 2 at 2 dp.
    expect(info.minBaseAmount).toBe("2.00");
  });

  test("created_at stays a string — it is epoch milliseconds that looks like a number", () => {
    const info: MarketInfo = toMarketInfo(goldenMarket("MAGS"));
    expect(typeof info.createdAt).toBe("string");
    expect(info.createdAt).toBe(goldenMarket("MAGS").created_at as string);
  });

  test("`multiplier` is raw and verbatim, folded into nothing (R21)", () => {
    expect(toMarketInfo(goldenMarket("MAGS")).multiplier).toBe("1.000000000000000000");
  });

  test("status is preserved — an inactive market still loads, it just is not tradable", () => {
    expect(toMarketInfo(goldenMarket("MAGS")).status).toBe("inactive");
    expect(toMarketInfo(goldenMarket("RAIL")).status).toBe("active");
  });

  test("a missing exponent throws, naming the market", () => {
    const raw: OrderBook = { ...goldenMarket("RAIL") };
    delete (raw as { supported_price_decimals?: number }).supported_price_decimals;
    expect((): MarketInfo => toMarketInfo(raw)).toThrow(LighterConfigError);
    expect((): MarketInfo => toMarketInfo(raw)).toThrow(/market 184: `supported_price_decimals`/);
  });

  test("a monetary field that is not a plain decimal string throws rather than becoming NaN", () => {
    const raw: OrderBook = { ...goldenMarket("RAIL"), min_quote_amount: "" };
    expect((): MarketInfo => toMarketInfo(raw)).toThrow(/not a plain decimal string/);
  });

  test("NilMarketIndex is refused as a market", () => {
    const raw: OrderBook = { ...goldenMarket("RAIL"), market_id: NIL_MARKET_INDEX };
    expect((): MarketInfo => toMarketInfo(raw)).toThrow(/cancel-all sentinel/);
  });

  test("the market kind falls back to the id range when the field is absent", () => {
    const raw: OrderBook = { ...goldenMarket("RAIL") };
    delete (raw as { market_type?: "perp" | "spot" }).market_type;
    expect(toMarketInfo(raw).marketType).toBe("perp");
    expect(toMarketInfo({ ...raw, market_id: 2048 }).marketType).toBe("spot");
  });
});

describe("the cross-scale invariant", () => {
  test("every captured market satisfies it", () => {
    for (const raw of goldenMarkets()) {
      const info: MarketInfo = toMarketInfo(raw);
      expect(info.priceDecimals + info.sizeDecimals).toBe(info.quoteDecimals);
      expect(info.quoteSizingSupported).toBe(true);
    }
  });

  test("a violating market loads with quoteSizingSupported false, and the rest still load", async () => {
    const violator: PerpsOrderBookDetail = derivedCrossScaleViolator("MAGS", 200);
    const { registry, diagnostics } = rig(orderBookDetailsBody([violator]));
    await registry.load();

    // The registry did not refuse the whole response...
    expect(registry.list().length).toBe(goldenMarkets().length + 1);
    for (const raw of goldenMarkets()) {
      expect(registry.get(raw.market_id as number).quoteSizingSupported).toBe(true);
    }
    // ...and the one bad market is flagged rather than dropped or silently accepted.
    const bad: MarketInfo = registry.get(200);
    expect(bad.quoteSizingSupported).toBe(false);
    expect(bad.priceDecimals + bad.sizeDecimals).not.toBe(bad.quoteDecimals);

    const warnings = diagnostics.filter((d: Diagnostic): boolean => d.event === "markets.cross_scale_violation");
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.detail?.["marketId"]).toBe(200);
  });
});

describe("lookup", () => {
  test("by id, and by unambiguous symbol, case-insensitively", async () => {
    const { registry } = rig();
    await registry.load();
    const rail: OrderBook = goldenMarket("RAIL");
    expect(registry.get(rail.market_id as number).symbol).toBe("RAIL");
    expect(registry.get("rail").marketId).toBe(rail.market_id as number);
    expect(registry.get({ symbol: "RAIL", type: "perp" })).toBe(registry.get(rail.market_id as number));
  });

  test("get(255) throws — NilMarketIndex is never a market", async () => {
    const { registry } = rig();
    await registry.load();
    expect((): MarketInfo => registry.get(NIL_MARKET_INDEX)).toThrow(LighterConfigError);
    expect((): MarketInfo => registry.get(255)).toThrow(/unknown market 255/);
  });

  test("an unknown symbol throws rather than guessing a scale", async () => {
    const { registry } = rig();
    await registry.load();
    expect((): MarketInfo => registry.get("NOPE")).toThrow(LighterConfigError);
    expect((): MarketInfo => registry.get("NOPE")).toThrow(/unknown market "NOPE"/);
    expect(registry.tryGet("NOPE")).toBeUndefined();
  });

  test("a bare symbol listed on both market types throws, naming both ids", async () => {
    const spotDia = derivedSpotMarket("DIA", 2048);
    const { registry } = rig(orderBookDetailsBody([], [spotDia]));
    await registry.load();

    let message: string = "";
    try {
      registry.get("DIA");
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("ambiguous");
    expect(message).toContain("perp id 152");
    expect(message).toContain("spot id 2048");

    // And the qualified forms resolve without complaint.
    expect(registry.get({ symbol: "DIA", type: "perp" }).marketId).toBe(152);
    expect(registry.get({ symbol: "DIA", type: "spot" }).marketId).toBe(2048);
    expect(registry.get(2048).marketType).toBe("spot");
  });

  test("tryGet also refuses to pick one of two — undefined would read as 'no such market'", async () => {
    const { registry } = rig(orderBookDetailsBody([], [derivedSpotMarket("DIA", 2048)]));
    await registry.load();
    expect((): MarketInfo | undefined => registry.tryGet("DIA")).toThrow(/ambiguous/);
  });

  test("a miss before any load says so", () => {
    const { registry } = rig();
    expect((): MarketInfo => registry.get("RAIL")).toThrow(/never been loaded/);
  });

  test("list() is ordered by marketId and filters by type", async () => {
    const { registry } = rig(orderBookDetailsBody([], [derivedSpotMarket("DIA", 2048)]));
    await registry.load();
    const ids: number[] = registry.list().map((m: MarketInfo): number => m.marketId);
    expect(ids).toEqual([...ids].sort((a: number, b: number): number => a - b));
    expect(registry.list({ type: "spot" }).map((m: MarketInfo): number => m.marketId)).toEqual([2048]);
    expect(registry.list({ type: "perp" }).length).toBe(goldenMarkets().length);
  });
});

describe("perps detail", () => {
  test("margin fractions and market_config come through when loaded from /orderBookDetails", async () => {
    const { registry } = rig();
    await registry.load();
    const info: MarketInfo = registry.get("RAIL");
    expect(info.perps?.defaultInitialMarginFraction).toBe(500);
    expect(info.perps?.minInitialMarginFraction).toBe(200);
    expect(info.perps?.markPrice).toBe("64398.5");
    expect(info.perps?.marketConfig?.rfqEnabled).toBe(true);
    expect(info.perps?.marketConfig?.forceReduceOnly).toBe(false);
    expect(info.perps?.marketConfig?.tradingHours).toBe("");
    // The undocumented multiplier is surfaced, not applied.
    expect(info.perps?.quoteMultiplier).toBe(1);
  });

  test("spot markets carry no perps block", async () => {
    const { registry } = rig(orderBookDetailsBody([], [derivedSpotMarket("DIA", 2048)]));
    await registry.load();
    expect(registry.get(2048).perps).toBeUndefined();
  });
});

describe("load policy", () => {
  test("two overlapping loads issue exactly one request per endpoint", async () => {
    const { registry, server } = rig();
    await Promise.all([registry.load(), registry.load(), registry.load()]);
    expect(server.countOf(PATH_ORDER_BOOK_DETAILS)).toBe(1);
    expect(server.countOf(PATH_ASSET_DETAILS)).toBe(1);
    expect(server.total()).toBe(2);
  });

  test("/orderBooks is the fallback when the detail endpoint comes back empty", async () => {
    const { registry, server, diagnostics } = rig({ code: 200, order_book_details: [], spot_order_book_details: [] });
    await registry.load();
    expect(server.countOf(PATH_ORDER_BOOKS)).toBe(1);
    expect(registry.list().length).toBe(goldenMarkets().length);
    // Without the perps half, but with the decimals — which is the part orders cannot do without.
    expect(registry.get("RAIL").perps).toBeUndefined();
    expect(registry.get("RAIL").sizeDecimals).toBe(goldenMarket("RAIL").supported_size_decimals as number);
    expect(diagnostics.some((d: Diagnostic): boolean => d.event === "markets.details_empty")).toBe(true);
  });

  test("a second load inside the TTL is a no-op; force refetches", async () => {
    const clock = fakeClock();
    const server: FakeServer = fakeServer({
      [PATH_ORDER_BOOK_DETAILS]: (): Response => jsonResponse(orderBookDetailsBody()),
      [PATH_ASSET_DETAILS]: (): Response => jsonResponse(goldenAssetDetails()),
    });
    const registry: MarketRegistry = new MarketRegistry({ rest: server.client, ttlMs: 1000, now: clock.now });
    await registry.load();
    await registry.load();
    expect(server.countOf(PATH_ORDER_BOOK_DETAILS)).toBe(1);

    await registry.load({ force: true });
    expect(server.countOf(PATH_ORDER_BOOK_DETAILS)).toBe(2);

    clock.advance(1001);
    expect(registry.stale).toBe(true);
    await registry.load();
    expect(server.countOf(PATH_ORDER_BOOK_DETAILS)).toBe(3);
    registry.stop();
  });

  test("load() without a transport throws a config error naming the fix", async () => {
    const registry: MarketRegistry = new MarketRegistry();
    await expect(registry.load()).rejects.toThrow(/setTransport/);
  });

  test("a duplicate market id is refused rather than silently shadowing", async () => {
    const dupe: PerpsOrderBookDetail = { ...goldenMarket("RAIL") };
    const { registry } = rig(orderBookDetailsBody([dupe]));
    await expect(registry.load()).rejects.toThrow(/duplicate market id 184/);
  });
});

describe("snapshot", () => {
  test("round-trips through JSON deep-equal, with no bigint and no undefined holes", async () => {
    const { registry } = rig(orderBookDetailsBody([], [derivedSpotMarket("DIA", 2048)]));
    await registry.load();

    const snapshot: MarketSnapshot = registry.toSnapshot();
    const text: string = JSON.stringify(snapshot);
    const revived: MarketSnapshot = JSON.parse(text) as MarketSnapshot;
    expect(revived).toEqual(snapshot as unknown as MarketSnapshot);

    const restored: MarketRegistry = MarketRegistry.fromSnapshot(revived);
    expect(restored.list()).toEqual(registry.list() as MarketInfo[]);
    expect(restored.assets.list()).toEqual(registry.assets.list() as never);
    expect(JSON.stringify(restored.toSnapshot())).toBe(text);

    // The nested perps block survives the trip intact, not flattened to undefined.
    expect(restored.get("RAIL").perps?.marketConfig?.rfqEnabled).toBe(true);
  });

  test("fromSnapshot performs no I/O, returns no promise, and needs no transport", () => {
    const snapshot: MarketSnapshot = {
      version: 1,
      loadedAt: 1_700_000_000_000,
      markets: goldenMarkets().map((m: OrderBook): MarketInfo => toMarketInfo(m)),
      assets: { version: 1, loadedAt: null, assets: [] },
    };
    const built: MarketRegistry = MarketRegistry.fromSnapshot(snapshot);
    expect(built).toBeInstanceOf(MarketRegistry);
    expect(built.get("RAIL").sizeDecimals).toBe(goldenMarket("RAIL").supported_size_decimals as number);
    expect(built.loadedAt).toBe(1_700_000_000_000);
  });

  test("fromSnapshot does not freeze the caller's own objects", () => {
    const markets: MarketInfo[] = goldenMarkets().map((m: OrderBook): MarketInfo => ({ ...toMarketInfo(m) }));
    MarketRegistry.fromSnapshot({ version: 1, loadedAt: null, markets, assets: { version: 1, loadedAt: null, assets: [] } });
    expect(Object.isFrozen(markets[0])).toBe(false);
  });

  test("an unknown snapshot version is refused rather than half-read", () => {
    const bad = { version: 9, loadedAt: null, markets: [], assets: { version: 1, loadedAt: null, assets: [] } };
    expect((): MarketRegistry => MarketRegistry.fromSnapshot(bad as unknown as MarketSnapshot)).toThrow(
      /unsupported version/,
    );
  });

  test("fresh markets with no assets still load the asset table", async () => {
    // A snapshot may legitimately carry one table and not the other. Judging freshness once, for
    // both, would report the registry loaded and leave `asset()` permanently empty.
    const server: FakeServer = fakeServer({
      [PATH_ORDER_BOOK_DETAILS]: (): Response => jsonResponse(orderBookDetailsBody()),
      [PATH_ASSET_DETAILS]: (): Response => jsonResponse(goldenAssetDetails()),
    });
    const clock = fakeClock();
    const built: MarketRegistry = MarketRegistry.fromSnapshot(
      {
        version: 1,
        loadedAt: clock.now(),
        markets: goldenMarkets().map((m: OrderBook): MarketInfo => toMarketInfo(m)),
        assets: { version: 1, loadedAt: null, assets: [] },
      },
      { rest: server.client, ttlMs: 300_000, now: clock.now },
    );
    await built.load();
    expect(built.asset("USDC").decimals).toBe(6);
    expect(server.countOf(PATH_ASSET_DETAILS)).toBe(1);
    // The still-fresh market table was not refetched.
    expect(server.countOf(PATH_ORDER_BOOK_DETAILS)).toBe(0);
    built.stop();
  });

  test("a snapshot revalidates against a transport attached afterwards", async () => {
    const server: FakeServer = fakeServer({
      [PATH_ORDER_BOOK_DETAILS]: (): Response => jsonResponse(orderBookDetailsBody()),
      [PATH_ASSET_DETAILS]: (): Response => jsonResponse(goldenAssetDetails()),
    });
    const built: MarketRegistry = MarketRegistry.fromSnapshot({
      version: 1,
      loadedAt: null,
      markets: [],
      assets: { version: 1, loadedAt: null, assets: [] },
    });
    expect(built.list()).toEqual([]);
    built.setTransport(server.client);
    await built.load();
    expect(built.list().length).toBe(goldenMarkets().length);
    expect(built.asset("USDC").decimals).toBe(6);
    built.stop();
  });
});

describe("disposal", () => {
  test("stop() leaves no timer scheduled, here or in the asset registry", async () => {
    const clock = fakeClock();
    const server: FakeServer = fakeServer({
      [PATH_ORDER_BOOK_DETAILS]: (): Response => jsonResponse(orderBookDetailsBody()),
      [PATH_ASSET_DETAILS]: (): Response => jsonResponse(goldenAssetDetails()),
    });
    const registry: MarketRegistry = new MarketRegistry({ rest: server.client, ttlMs: 1000, now: clock.now });
    await registry.load();
    clock.advance(5000);

    recordTimers((log): void => {
      registry.get("RAIL"); // stale read: serves the stale value, schedules a background refresh
      registry.asset("USDC");
      expect(registry.refreshScheduled).toBe(true);
      expect(log.created.length).toBe(2);

      registry.stop();
      expect(registry.refreshScheduled).toBe(false);
      expect(log.outstanding()).toEqual([]);
    });

    registry.get("RAIL");
    expect(registry.refreshScheduled).toBe(false);
  });

  test("`using` disposes the registry where Symbol.dispose exists", async () => {
    const disposeSym: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
    if (disposeSym === undefined) return; // Node 20 and older Safari: `stop()` is the documented path
    const clock = fakeClock();
    const server: FakeServer = fakeServer({
      [PATH_ORDER_BOOK_DETAILS]: (): Response => jsonResponse(orderBookDetailsBody()),
      [PATH_ASSET_DETAILS]: (): Response => jsonResponse(goldenAssetDetails()),
    });
    const registry: MarketRegistry = new MarketRegistry({ rest: server.client, ttlMs: 1000, now: clock.now });
    await registry.load();
    clock.advance(5000);
    registry.get("RAIL");
    expect(registry.refreshScheduled).toBe(true);

    (registry as unknown as Record<symbol, () => void>)[disposeSym]?.();
    expect(registry.refreshScheduled).toBe(false);
  });

  test("a stale read is synchronous and returns the stale value", async () => {
    const clock = fakeClock();
    const server: FakeServer = fakeServer({
      [PATH_ORDER_BOOK_DETAILS]: (): Response => jsonResponse(orderBookDetailsBody()),
      [PATH_ASSET_DETAILS]: (): Response => jsonResponse(goldenAssetDetails()),
    });
    const registry: MarketRegistry = new MarketRegistry({ rest: server.client, ttlMs: 1, now: clock.now });
    await registry.load();
    clock.advance(1000);
    expect(registry.stale).toBe(true);
    expect(registry.get("RAIL").symbol).toBe("RAIL");
    registry.stop();
  });

  test("a failed background refresh is a diagnostic, not a thrown error", async () => {
    const clock = fakeClock();
    let healthy: boolean = true;
    const seen: Diagnostic[] = [];
    const server: FakeServer = fakeServer({
      [PATH_ORDER_BOOK_DETAILS]: (): Response =>
        healthy ? jsonResponse(orderBookDetailsBody()) : jsonResponse({ code: 20001, message: "down" }, 400),
      [PATH_ASSET_DETAILS]: (): Response => jsonResponse(goldenAssetDetails()),
    });
    const registry: MarketRegistry = new MarketRegistry({
      rest: server.client,
      ttlMs: 1000,
      now: clock.now,
      onDiagnostic: (d: Diagnostic): void => {
        seen.push(d);
      },
    });
    await registry.load();
    healthy = false;
    clock.advance(5000);

    expect(registry.get("RAIL").symbol).toBe("RAIL"); // does not throw, does not block
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 20);
    });
    expect(seen.some((d: Diagnostic): boolean => d.event === "markets.refresh_failed")).toBe(true);
    // The stale table is still there — a failed refresh must not empty the registry.
    expect(registry.get("RAIL").symbol).toBe("RAIL");
    registry.stop();
  });
});
