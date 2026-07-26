/**
 * Tests for the typed channel registry.
 *
 * Three things are being defended here, in descending order of how expensive they are to get wrong:
 *
 * 1. **Keys are exact.** A wrong key is answered by a bare 30005, or worse, subscribes successfully
 *    to the wrong thing — `account_market/{M}/{A}` with the arguments swapped is a perfectly valid
 *    key for a different market/account pair, and the server will happily stream it.
 * 2. **`requiresAuth` / `acceptsAuth` match the table** in the issue and in
 *    `docs/spec/06-websocket.md` §6.1. Getting `requiresAuth` wrong means a silent subscribe
 *    failure; getting `acceptsAuth` wrong means a channel that works today breaks the day the server
 *    tightens its policy.
 * 3. **Parsing never throws**, for any input. The reference client raises on anything it does not
 *    recognise, which kills its own read loop (`docs/protocol-notes.md` §10.2).
 */

import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../src/errors.js";
import { channels } from "../../src/ws/channels.js";
import type { ChannelSpec } from "../../src/ws/channels.js";
import type { AccountAllTradesSnapshot, AccountAllTradesUpdate } from "../../src/ws/types.js";

/** Every factory, invoked with plausible arguments. One row per channel. */
function everySpec(): readonly ChannelSpec<unknown, unknown>[] {
  return [
    channels.orderBook(0),
    channels.ticker(1),
    channels.trades(2),
    channels.marketStats(3),
    channels.spotMarketStats(2048),
    channels.candles(0, "1m"),
    channels.markPriceCandles(0, "1h"),
    channels.height(),
    channels.accountAll(1234),
    channels.accountMarket(3, 1234),
    channels.accountStats(1234),
    channels.accountTxs(1234),
    channels.accountOrders(1234),
    channels.accountMarketOrders(3, 1234),
    channels.accountTrades(1234),
    channels.accountPositions(1234),
    channels.accountAssets(1234),
    channels.accountSpotAvgEntry(1234),
    channels.poolData(1234),
    channels.poolInfo(1234),
    channels.notifications(1234),
    channels.rfq(),
  ];
}

describe("the registry is complete", () => {
  test("exposes all 22 channels", () => {
    expect(Object.keys(channels)).toHaveLength(22);
    expect(everySpec()).toHaveLength(22);
  });

  test("every factory is a function and every key is distinct", () => {
    for (const name of Object.keys(channels)) {
      expect(typeof (channels as unknown as Record<string, unknown>)[name]).toBe("function");
    }
    const keys: string[] = everySpec().map((s) => s.key);
    expect(new Set(keys).size).toBe(22);
  });
});

describe("keys are exact, in the outbound slash spelling", () => {
  test("the spellings named in the issue", () => {
    expect(channels.orderBook(0).key).toBe("order_book/0");
    expect(channels.candles(0, "1m").key).toBe("candle/0/1m");
    expect(channels.marketStats("all").key).toBe("market_stats/all");
    expect(channels.height().key).toBe("height");
    expect(channels.rfq().key).toBe("rfq");
    expect(channels.accountMarket(3, 1234).key).toBe("account_market/3/1234");
    expect(channels.accountMarketOrders(3, 1234).key).toBe("account_orders/3/1234");
  });

  test("the remaining fifteen", () => {
    expect(channels.ticker(1).key).toBe("ticker/1");
    expect(channels.trades(2).key).toBe("trade/2");
    expect(channels.marketStats(3).key).toBe("market_stats/3");
    expect(channels.spotMarketStats(2048).key).toBe("spot_market_stats/2048");
    expect(channels.spotMarketStats("all").key).toBe("spot_market_stats/all");
    expect(channels.markPriceCandles(0, "1h").key).toBe("mark_price_candle/0/1h");
    expect(channels.accountAll(1234).key).toBe("account_all/1234");
    expect(channels.accountStats(1234).key).toBe("user_stats/1234");
    expect(channels.accountTxs(1234).key).toBe("account_tx/1234");
    expect(channels.accountOrders(1234).key).toBe("account_all_orders/1234");
    expect(channels.accountTrades(1234).key).toBe("account_all_trades/1234");
    expect(channels.accountPositions(1234).key).toBe("account_all_positions/1234");
    expect(channels.accountAssets(1234).key).toBe("account_all_assets/1234");
    expect(channels.accountSpotAvgEntry(1234).key).toBe("account_spot_avg_entry_prices/1234");
    expect(channels.poolData(1234).key).toBe("pool_data/1234");
    expect(channels.poolInfo(1234).key).toBe("pool_info/1234");
    expect(channels.notifications(1234).key).toBe("notification/1234");
  });

  test("the two-index channels put the market first", () => {
    // Swapping the arguments must produce a *different*, equally valid-looking key. That is the
    // hazard: the server accepts both.
    expect(channels.accountMarket(3, 1234).key).not.toBe(channels.accountMarket(1234, 3).key);
    expect(channels.accountMarket(3, 1234).marketIndex).toBe(3);
    expect(channels.accountMarket(3, 1234).accountIndex).toBe(1234);
    expect(channels.accountMarketOrders(3, 1234).marketIndex).toBe(3);
    expect(channels.accountMarketOrders(3, 1234).accountIndex).toBe(1234);
  });

  test("the family is the key with no index, matching the inbound type suffix", () => {
    expect(channels.orderBook(0).family).toBe("order_book");
    expect(channels.trades(2).family).toBe("trade"); // singular family, plural payload key
    expect(channels.accountOrders(1).family).toBe("account_all_orders");
    expect(channels.accountMarketOrders(3, 1).family).toBe("account_orders");
    expect(channels.accountStats(1).family).toBe("user_stats");
    expect(channels.accountAssets(1).family).toBe("account_all_assets");
    for (const spec of everySpec()) {
      expect(spec.key === spec.family || spec.key.startsWith(`${spec.family}/`)).toBe(true);
    }
  });
});

describe("the auth table", () => {
  const REQUIRES_AUTH: ReadonlySet<string> = new Set<string>([
    "account_market",
    "account_tx",
    "account_all_orders",
    "account_orders",
    "account_all_assets",
    "account_spot_avg_entry_prices",
    "pool_data",
    "pool_info",
    "notification",
    "rfq",
  ]);

  const ACCEPTS_AUTH: ReadonlySet<string> = new Set<string>([
    "account_all",
    "account_market",
    "user_stats",
    "account_tx",
    "account_all_orders",
    "account_orders",
    "account_all_trades",
    "account_all_positions",
    "account_all_assets",
    "account_spot_avg_entry_prices",
    "pool_data",
    "pool_info",
    "notification",
    "rfq",
  ]);

  test("requiresAuth matches the table for all 22 channels", () => {
    for (const spec of everySpec()) {
      expect(spec.requiresAuth, spec.key).toBe(REQUIRES_AUTH.has(spec.family));
    }
    expect(everySpec().filter((s) => s.requiresAuth)).toHaveLength(10);
  });

  test("acceptsAuth matches the table for all 22 channels", () => {
    for (const spec of everySpec()) {
      expect(spec.acceptsAuth, spec.key).toBe(ACCEPTS_AUTH.has(spec.family));
    }
    expect(everySpec().filter((s) => s.acceptsAuth)).toHaveLength(14);
  });

  test("requiring auth implies accepting it", () => {
    for (const spec of everySpec()) {
      if (spec.requiresAuth) expect(spec.acceptsAuth, spec.key).toBe(true);
    }
  });

  test("no candle-family channel takes auth", () => {
    for (const spec of [channels.candles(0, "1d"), channels.markPriceCandles(0, "1d")]) {
      expect(spec.requiresAuth).toBe(false);
      expect(spec.acceptsAuth).toBe(false);
    }
  });
});

describe("indices are populated wherever one exists", () => {
  test("account-scoped channels carry accountIndex, including the account_orders family", () => {
    const accountScoped: readonly ChannelSpec<unknown, unknown>[] = [
      channels.accountAll(7),
      channels.accountMarket(3, 7),
      channels.accountStats(7),
      channels.accountTxs(7),
      channels.accountOrders(7),
      channels.accountMarketOrders(3, 7),
      channels.accountTrades(7),
      channels.accountPositions(7),
      channels.accountAssets(7),
      channels.accountSpotAvgEntry(7),
      channels.poolData(7),
      channels.poolInfo(7),
      channels.notifications(7),
    ];
    expect(accountScoped).toHaveLength(13);
    for (const spec of accountScoped) expect(spec.accountIndex, spec.key).toBe(7);
  });

  test("market-scoped channels carry marketIndex", () => {
    expect(channels.orderBook(5).marketIndex).toBe(5);
    expect(channels.ticker(5).marketIndex).toBe(5);
    expect(channels.trades(5).marketIndex).toBe(5);
    expect(channels.marketStats(5).marketIndex).toBe(5);
    expect(channels.spotMarketStats(2048).marketIndex).toBe(2048);
    expect(channels.candles(5, "4h").marketIndex).toBe(5);
    expect(channels.markPriceCandles(5, "4h").marketIndex).toBe(5);
  });

  test("the all wildcard carries no market index at all", () => {
    const spec = channels.marketStats("all");
    expect(spec.marketIndex).toBeUndefined();
    expect("marketIndex" in spec).toBe(false);
    expect("accountIndex" in spec).toBe(false);
  });

  test("indexless channels carry neither", () => {
    for (const spec of [channels.height(), channels.rfq()]) {
      expect("marketIndex" in spec).toBe(false);
      expect("accountIndex" in spec).toBe(false);
    }
  });

  test("spot markets are not assumed to be low indices", () => {
    expect(channels.spotMarketStats(2048).key).toBe("spot_market_stats/2048");
    expect(channels.orderBook(4096).key).toBe("order_book/4096");
  });
});

describe("parseSnapshot and parseUpdate never throw", () => {
  test("for an empty object, null, and a wrong-shaped payload", () => {
    for (const spec of everySpec()) {
      expect(() => spec.parseSnapshot({})).not.toThrow();
      expect(() => spec.parseUpdate({})).not.toThrow();
      expect(() => spec.parseSnapshot(null)).not.toThrow();
      expect(() => spec.parseUpdate(null)).not.toThrow();
      expect(() => spec.parseSnapshot(42)).not.toThrow();
      expect(() => spec.parseUpdate("nonsense")).not.toThrow();
      expect(() => spec.parseSnapshot([])).not.toThrow();
      expect(spec.parseSnapshot(null)).toBeNull();
    }
  });

  test("a payload missing every optional field yields undefined, not an exception", () => {
    const msg = channels.orderBook(0).parseSnapshot({
      type: "subscribed/order_book",
      channel: "order_book:0",
      order_book: {},
    });
    expect(msg.order_book.asks).toBeUndefined();
    expect(msg.order_book.begin_nonce).toBeUndefined();
    expect(msg.timestamp).toBeUndefined();
  });

  test("invented extra keys survive untouched", () => {
    const raw: Record<string, unknown> = {
      type: "update/trade",
      channel: "trade:1",
      trades: [],
      some_future_field: { nested: 1 },
      another_one: "kept",
    };
    const parsed = channels.trades(1).parseUpdate(raw);
    // Identity, not a copy: nothing is rewritten, nothing is dropped.
    expect(parsed).toBe(raw as never);
    expect((parsed as unknown as Record<string, unknown>)["some_future_field"]).toEqual({
      nested: 1,
    });
    expect((parsed as unknown as Record<string, unknown>)["another_one"]).toBe("kept");
  });

  test("wide integers are left exactly as parseFrameJson delivered them", () => {
    // parseFrameJson quotes 16+ digit integers; the registry must not undo or re-round that.
    const msg = channels.orderBook(0).parseSnapshot({
      type: "subscribed/order_book",
      channel: "order_book:0",
      order_book: { nonce: "9223372036854775807", offset: 12 },
    });
    expect(msg.order_book.nonce).toBe("9223372036854775807");
    expect(msg.order_book.offset).toBe(12);
  });

  test("money is never converted", () => {
    const msg = channels.orderBook(0).parseSnapshot({
      type: "subscribed/order_book",
      channel: "order_book:0",
      order_book: { asks: [{ price: "2064.50", size: "0.0000" }] },
    });
    // "2064.50" must not become 2064.5, and "0.0000" must not become 0.
    expect(msg.order_book.asks?.[0]?.price).toBe("2064.50");
    expect(msg.order_book.asks?.[0]?.size).toBe("0.0000");
  });

  test("the candle v/V case distinction survives parsing", () => {
    const msg = channels.candles(0, "1m").parseUpdate({
      type: "update/candle",
      channel: "candle:0:1m",
      candles: [{ t: 1750003200000, v: 602.98999, V: 63632159.996563 }],
    });
    expect(msg.candles?.[0]?.v).toBe(602.98999);
    expect(msg.candles?.[0]?.V).toBe(63632159.996563);
    expect(msg.candles?.[0]?.v).not.toBe(msg.candles?.[0]?.V);
  });
});

describe("the snapshot/update asymmetry is expressed in the types", () => {
  test("account_all_trades has distinct trades shapes", () => {
    const spec = channels.accountTrades(1);
    const snapshot: AccountAllTradesSnapshot = spec.parseSnapshot({
      type: "subscribed/account_all_trades",
      channel: "account_all_trades:1",
      trades: [{ trade_id_str: "1" }],
      total_volume: 12.5,
    });
    const update: AccountAllTradesUpdate = spec.parseUpdate({
      type: "update/account_all_trades",
      channel: "account_all_trades:1",
      trades: { "0": [{ trade_id_str: "2" }] },
    });
    expect(snapshot.trades?.[0]?.trade_id_str).toBe("1");
    expect(snapshot.total_volume).toBe(12.5);
    expect(update.trades?.["0"]?.[0]?.trade_id_str).toBe("2");
  });
});

describe("argument checking", () => {
  test("a nonsensical index is refused up front, not on the wire", () => {
    expect(() => channels.orderBook(-1)).toThrow(LighterValidationError);
    expect(() => channels.orderBook(1.5)).toThrow(LighterValidationError);
    expect(() => channels.accountAll(Number.NaN)).toThrow(LighterValidationError);
    expect(() => channels.accountMarket(3, -1)).toThrow(LighterValidationError);
  });

  test("an unsupported candle resolution is refused", () => {
    // Valid for REST /candles, not for this transport.
    expect(() => channels.candles(0, "1w" as never)).toThrow(LighterValidationError);
    expect(() => channels.markPriceCandles(0, "" as never)).toThrow(LighterValidationError);
  });

  test("specs are frozen, so a key cannot be mutated after registration", () => {
    const spec = channels.orderBook(0);
    expect(Object.isFrozen(spec)).toBe(true);
  });
});
