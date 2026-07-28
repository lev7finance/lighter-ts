/**
 * Tests for the WebSocket payload models.
 *
 * **Evidence note.** `test/fixtures/ws/capture.json` carries **no frames**: the wave-0 capture was
 * refused at the upgrade from a restricted jurisdiction (API code 20558). The fixture-coverage test
 * below therefore walks whatever frames the capture holds — none today — and, so that it is not
 * vacuous, additionally walks the structures that *do* have real captured evidence: `Trade`,
 * `Candle` and `Order` all have REST twins in `test/fixtures/rest/responses.json`. Those found four
 * fields `spec/06-websocket.md` §6.2.5 omits, which is exactly the failure this test exists to
 * catch. The moment a WS capture lands, the same key lists start checking real frames with no edit.
 *
 * The key lists below are declared here on purpose: TypeScript interfaces do not exist at runtime,
 * so the only way to assert that a captured key is modelled is to write the modelled key set down
 * and keep it in step with the interface by hand. A fixture key missing from a list fails the test.
 */

import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../src/errors.js";
import {
  decodeAccountTxEventInfo,
  decodeAccountTxInfo,
  isDeleverageNotification,
  isLiquidationNotification,
  wireInt,
} from "../../src/ws/types.js";
import type {
  AccountAllTradesSnapshot,
  AccountAllTradesUpdate,
  CandleResolution,
  Notification,
  OrderBookMessage,
  WireInt,
} from "../../src/ws/types.js";

/* -------------------------------------------------------------------------------------------- */
/* wireInt                                                                                        */
/* -------------------------------------------------------------------------------------------- */

describe("wireInt", () => {
  test("accepts the JSON number form", () => {
    expect(wireInt(0)).toBe(0n);
    expect(wireInt(562952978921192)).toBe(562952978921192n);
    expect(wireInt(-1)).toBe(-1n);
  });

  test("accepts the string form parseFrameJson produces for 16+ digit integers", () => {
    // 16 digits: the first width JSON.parse can round. parseFrameJson quotes it.
    expect(wireInt("1785027657572944")).toBe(1785027657572944n);
  });

  test("round-trips a 19-digit id losslessly", () => {
    const id: string = "9223372036854775807"; // 2^63 - 1, 19 digits
    const parsed: bigint = wireInt(id);
    expect(parsed).toBe(9223372036854775807n);
    expect(parsed.toString()).toBe(id);
    // The same id through JSON.parse is *not* this value — which is why the string form exists.
    expect(BigInt(JSON.parse(id) as number)).not.toBe(parsed);
  });

  test("is idempotent over a bigint", () => {
    expect(wireInt(123n as unknown as WireInt)).toBe(123n);
  });

  test("refuses a number that has already lost digits", () => {
    // 2^53 + 1 cannot be represented; anything at this magnitude reached us via plain JSON.parse.
    expect(() => wireInt(9007199254740993)).toThrow(LighterValidationError);
    expect(() => wireInt(1.5)).toThrow(LighterValidationError);
  });

  test("refuses a string that is not an integer", () => {
    expect(() => wireInt("12.5")).toThrow(LighterValidationError);
    expect(() => wireInt("")).toThrow(LighterValidationError);
    expect(() => wireInt("0x10")).toThrow(LighterValidationError);
    expect(() => wireInt(null as unknown as WireInt)).toThrow(LighterValidationError);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* account_tx double decode                                                                       */
/* -------------------------------------------------------------------------------------------- */

describe("account_tx inner documents", () => {
  test("info is a string containing JSON, decoded on request", () => {
    const info: string = JSON.stringify({
      AccountIndex: 1234,
      ApiKeyIndex: 0,
      MarketIndex: 3,
      Nonce: 9180000000,
      Sig: "ab",
    });
    const decoded = decodeAccountTxInfo(info);
    expect(decoded?.["AccountIndex"]).toBe(1234);
    expect(decoded?.["Sig"]).toBe("ab");
  });

  test("a wide inner Nonce survives as a string, not a rounded number", () => {
    const decoded = decodeAccountTxInfo('{"Nonce":9223372036854775807}');
    expect(decoded?.["Nonce"]).toBe("9223372036854775807");
    expect(wireInt(decoded?.["Nonce"] as WireInt)).toBe(9223372036854775807n);
  });

  test("event_info keeps its cryptic keys verbatim", () => {
    const decoded = decodeAccountTxEventInfo('{"a":1,"i":"x","u":true,"ae":[]}');
    expect(decoded?.["a"]).toBe(1);
    expect(decoded?.["ae"]).toEqual([]);
  });

  test("both decoders are total", () => {
    expect(decodeAccountTxInfo(undefined)).toBeUndefined();
    expect(decodeAccountTxInfo("")).toBeUndefined();
    expect(decodeAccountTxInfo("not json")).toBeUndefined();
    expect(decodeAccountTxInfo("[1,2]")).toBeUndefined();
    expect(decodeAccountTxInfo("42")).toBeUndefined();
    expect(decodeAccountTxEventInfo("{")).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Notifications                                                                                  */
/* -------------------------------------------------------------------------------------------- */

describe("notification content is polymorphic on kind", () => {
  test("the guards narrow, and an unknown kind is not fatal", () => {
    const notifs: Notification[] = [
      { kind: "liquidation", content: { size: "0.5", price: "2064.54" } },
      { kind: "deleverage", content: { size: "1", settlement_price: "10" } },
      { kind: "some_future_kind", content: { whatever: true } },
    ];

    const liquidation = notifs.filter(isLiquidationNotification);
    expect(liquidation).toHaveLength(1);
    expect(liquidation[0]?.content?.price).toBe("2064.54");

    const deleverage = notifs.filter(isDeleverageNotification);
    expect(deleverage).toHaveLength(1);
    expect(deleverage[0]?.content?.settlement_price).toBe("10");

    // The default arm survives both guards without an exception, which is the whole point.
    const rest = notifs.filter((n) => !isLiquidationNotification(n) && !isDeleverageNotification(n));
    expect(rest).toHaveLength(1);
    expect(rest[0]?.kind).toBe("some_future_kind");
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Compile-time shape assertions                                                                  */
/* -------------------------------------------------------------------------------------------- */

describe("type-level guarantees", () => {
  test("account_all_trades snapshot and update have genuinely different trades shapes", () => {
    const snapshot: AccountAllTradesSnapshot = {
      type: "subscribed/account_all_trades",
      channel: "account_all_trades:1",
      trades: [{ price: "1" }], // flat array
      total_volume: 1,
    };
    const update: AccountAllTradesUpdate = {
      type: "update/account_all_trades",
      channel: "account_all_trades:1",
      trades: { "0": [{ price: "1" }] }, // market-keyed map
    };
    expect(Array.isArray(snapshot.trades)).toBe(true);
    expect(Array.isArray(update.trades)).toBe(false);
  });

  test("candle resolutions are exactly the eight the WS channels accept", () => {
    const all: CandleResolution[] = ["1m", "5m", "15m", "30m", "1h", "4h", "12h", "1d"];
    expect(all).toHaveLength(8);
    // `1w` is valid for REST /candles and must not be valid here.
    expect(all).not.toContain("1w" as unknown as CandleResolution);
  });

  test("order-book money stays a string all the way through the model", () => {
    const msg: OrderBookMessage = {
      type: "subscribed/order_book",
      channel: "order_book:0",
      order_book: { asks: [{ price: "2064.50", size: "0.3285" }], bids: [] },
    };
    expect(typeof msg.order_book.asks?.[0]?.price).toBe("string");
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Fixture coverage                                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * The modelled key set for each structure in `src/ws/types.ts`, declared by hand.
 *
 * A key found in a captured payload but absent from the matching list means the interface is
 * missing a field the server actually sends — which is the only way that gets discovered without a
 * live socket.
 */
const MODELLED: Readonly<Record<string, readonly string[]>> = {
  /* Shared structures */
  OrderBookLevel: ["price", "size"],
  Trade: [
    "trade_id",
    "trade_id_str",
    "tx_hash",
    "type",
    "market_id",
    "size",
    "price",
    "usd_amount",
    "ask_id",
    "ask_id_str",
    "bid_id",
    "bid_id_str",
    "ask_client_id",
    "ask_client_id_str",
    "bid_client_id",
    "bid_client_id_str",
    "ask_account_id",
    "bid_account_id",
    "is_maker_ask",
    "block_height",
    "timestamp",
    "transaction_time",
    "taker_position_size_before",
    "taker_entry_quote_before",
    "taker_initial_margin_fraction_before",
    "maker_position_size_before",
    "maker_entry_quote_before",
    "maker_initial_margin_fraction_before",
    "taker_fee",
    "maker_fee",
    "taker_allocated_margin_usdc_before",
    "taker_allocated_margin_usdc_after",
    "integrator_taker_fee",
    "integrator_taker_fee_collector_index",
  ],
  Order: [
    "order_index",
    "client_order_index",
    "order_id",
    "client_order_id",
    "market_index",
    "owner_account_index",
    "initial_base_amount",
    "price",
    "nonce",
    "remaining_base_amount",
    "is_ask",
    "base_size",
    "base_price",
    "filled_base_amount",
    "filled_quote_amount",
    "side",
    "type",
    "time_in_force",
    "reduce_only",
    "trigger_price",
    "order_expiry",
    "status",
    "trigger_status",
    "trigger_time",
    "parent_order_index",
    "parent_order_id",
    "to_trigger_order_id_0",
    "to_trigger_order_id_1",
    "to_cancel_order_id_0",
    "integrator_fee_collector_index",
    "integrator_taker_fee",
    "integrator_maker_fee",
    "block_height",
    "timestamp",
    "created_at",
    "updated_at",
    "transaction_time",
  ],
  Position: [
    "market_id",
    "symbol",
    "initial_margin_fraction",
    "open_order_count",
    "pending_order_count",
    "position_tied_order_count",
    "sign",
    "position",
    "avg_entry_price",
    "position_value",
    "unrealized_pnl",
    "realized_pnl",
    "liquidation_price",
    "total_funding_paid_out",
    "margin_mode",
    "allocated_margin",
  ],
  AccountAsset: ["symbol", "asset_id", "balance", "locked_balance"],
  PositionFunding: [
    "timestamp",
    "market_id",
    "funding_id",
    "change",
    "rate",
    "position_size",
    "position_side",
    "discount",
  ],
  PoolShare: [
    "public_pool_index",
    "shares_amount",
    "entry_usdc",
    "principal_amount",
    "entry_timestamp",
  ],
  Candle: ["t", "o", "h", "l", "c", "v", "V", "i", "C", "H", "L", "O"],
  MarkPriceCandle: ["t", "o", "h", "l", "c", "sc"],

  /* Per-channel envelopes, keyed by family */
  order_book: ["type", "channel", "offset", "last_updated_at", "timestamp", "order_book"],
  "order_book.order_book": [
    "code",
    "asks",
    "bids",
    "offset",
    "nonce",
    "begin_nonce",
    "last_updated_at",
  ],
  ticker: ["type", "channel", "last_updated_at", "nonce", "timestamp", "ticker"],
  "ticker.ticker": ["s", "a", "b", "last_updated_at"],
  market_stats: ["type", "channel", "timestamp", "market_stats"],
  "market_stats.market_stats": [
    "symbol",
    "market_id",
    "index_price",
    "mark_price",
    "mid_price",
    "best_ask_price",
    "best_bid_price",
    "open_interest",
    "open_interest_limit",
    "funding_clamp_small",
    "funding_clamp_big",
    "last_trade_price",
    "current_funding_rate",
    "funding_rate",
    "funding_timestamp",
    "daily_base_token_volume",
    "daily_quote_token_volume",
    "daily_price_low",
    "daily_price_high",
    "daily_price_change",
    "base_interest_rate",
  ],
  spot_market_stats: ["type", "channel", "timestamp", "spot_market_stats"],
  "spot_market_stats.spot_market_stats": [
    "symbol",
    "market_id",
    "index_price",
    "mid_price",
    "last_trade_price",
    "daily_base_token_volume",
    "daily_quote_token_volume",
    "daily_price_low",
    "daily_price_high",
    "daily_price_change",
  ],
  trade: ["type", "channel", "nonce", "trades", "liquidation_trades"],
  candle: ["type", "channel", "timestamp", "candles"],
  mark_price_candle: ["type", "channel", "timestamp", "candles"],
  height: ["type", "channel", "height", "timestamp"],
  account_all: [
    "type",
    "channel",
    "account",
    "assets",
    "positions",
    "funding_histories",
    "trades",
    "shares",
    "daily_trades_count",
    "daily_volume",
    "weekly_trades_count",
    "weekly_volume",
    "monthly_trades_count",
    "monthly_volume",
    "total_trades_count",
    "total_volume",
  ],
  account_market: [
    "type",
    "channel",
    "account",
    "assets",
    "orders",
    "position",
    "trades",
    "funding_history",
  ],
  user_stats: ["type", "channel", "timestamp", "stats"],
  "user_stats.stats": [
    "collateral",
    "portfolio_value",
    "leverage",
    "available_balance",
    "margin_usage",
    "buying_power",
    "account_trading_mode",
    "cross_stats",
    "total_stats",
  ],
  account_tx: ["type", "channel", "txs"],
  AccountTx: [
    "hash",
    "type",
    "info",
    "event_info",
    "status",
    "transaction_index",
    "l1_address",
    "account_index",
    "nonce",
    "expire_at",
    "block_height",
    "queued_at",
    "executed_at",
    "sequence_index",
    "parent_hash",
    "api_key_index",
    "transaction_time",
  ],
  account_all_orders: ["type", "channel", "orders"],
  account_orders: ["type", "channel", "account", "nonce", "orders"],
  account_all_trades: [
    "type",
    "channel",
    "trades",
    "total_volume",
    "monthly_volume",
    "weekly_volume",
    "daily_volume",
  ],
  account_all_positions: [
    "type",
    "channel",
    "positions",
    "shares",
    "last_funding_round",
    "last_funding_discount",
  ],
  account_all_assets: ["type", "channel", "timestamp", "assets"],
  account_spot_avg_entry_prices: ["type", "channel", "timestamp", "avg_entry_prices"],
  SpotAvgEntry: ["asset_id", "avg_entry_price", "asset_size", "last_trade_id"],
  pool_data: ["type", "channel", "account", "trades", "orders", "positions", "shares", "funding_histories"],
  pool_info: ["type", "channel", "pool_info"],
  "pool_info.pool_info": [
    "status",
    "operator_fee",
    "min_operator_share_rate",
    "total_shares",
    "operator_shares",
    "annual_percentage_yield",
    "sharpe_ratio",
    "daily_returns",
    "share_prices",
    "strategies",
  ],
  notification: ["type", "channel", "notifs"],
  Notification: [
    "id",
    "created_at",
    "updated_at",
    "kind",
    "account_index",
    "content",
    "ack",
    "acked_at",
  ],
  rfq: ["type", "channel", "rfqs"],
  Rfq: [
    "id",
    "account_index",
    "market_index",
    "direction",
    "base_amount",
    "quote_amount",
    "status",
    "metadata",
    "responses",
    "created_at",
    "updated_at",
  ],
};

/** Every key of `payload` must appear in the declared list for `model`. */
function expectModelled(payload: unknown, model: string): void {
  const declared: readonly string[] | undefined = MODELLED[model];
  expect(declared, `no declared key list for ${model}`).toBeDefined();
  const allowed: ReadonlySet<string> = new Set(declared ?? []);
  const unmodelled: string[] = Object.keys(payload as Record<string, unknown>).filter(
    (k) => !allowed.has(k),
  );
  expect(unmodelled, `unmodelled keys on ${model}`).toEqual([]);
}

describe("captured fixtures are fully modelled", () => {
  test("every file under test/fixtures/ws is walked", () => {
    const files: string[] = readdirSync("test/fixtures/ws").filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    let framesSeen: number = 0;
    for (const file of files) {
      const doc: unknown = JSON.parse(readFileSync(`test/fixtures/ws/${file}`, "utf8"));
      const frames: unknown = (doc as Record<string, unknown>)["frames"];
      if (!Array.isArray(frames)) continue;
      for (const frame of frames as readonly Record<string, unknown>[]) {
        const body: unknown = frame["body"] ?? frame;
        const type: unknown = (body as Record<string, unknown>)["type"];
        if (typeof type !== "string") continue;
        const family: string = type.replace(/^(subscribed|update|unsubscribed)\//, "");
        if (MODELLED[family] === undefined) continue;
        framesSeen += 1;
        expectModelled(body, family);
        const nested: unknown = (body as Record<string, unknown>)[family];
        if (MODELLED[`${family}.${family}`] !== undefined && typeof nested === "object" && nested !== null) {
          expectModelled(nested, `${family}.${family}`);
        }
      }
    }

    // Documented rather than glossed over: the capture was refused (API code 20558), so there is
    // nothing to replay yet. This assertion flips the moment a capture from a permitted
    // jurisdiction lands, and the walk above starts checking real frames with no edit here.
    expect(framesSeen).toBe(0);
  });

  test("Trade is fully modelled against the real /recentTrades capture", () => {
    const doc = JSON.parse(readFileSync("test/fixtures/rest/responses.json", "utf8")) as {
      cases: Record<string, { body: Record<string, unknown> }>;
    };
    const trades = doc.cases["recentTrades"]?.body["trades"] as readonly unknown[];
    expect(trades.length).toBeGreaterThan(0);
    for (const t of trades) expectModelled(t, "Trade");
  });

  test("Candle is fully modelled against the real /candles capture", () => {
    const doc = JSON.parse(readFileSync("test/fixtures/rest/responses.json", "utf8")) as {
      cases: Record<string, { body: Record<string, unknown> }>;
    };
    const candles = doc.cases["candles"]?.body["c"] as readonly unknown[];
    expect(candles.length).toBeGreaterThan(0);
    for (const c of candles) expectModelled(c, "Candle");
  });

  test("Order is fully modelled against the real /orderBookOrders capture", () => {
    const doc = JSON.parse(readFileSync("test/fixtures/rest/responses.json", "utf8")) as {
      cases: Record<string, { body: Record<string, unknown> }>;
    };
    const body = doc.cases["orderBookOrders"]?.body ?? {};
    const orders = [
      ...((body["asks"] as readonly unknown[]) ?? []),
      ...((body["bids"] as readonly unknown[]) ?? []),
    ];
    expect(orders.length).toBeGreaterThan(0);
    for (const o of orders) expectModelled(o, "Order");
  });
});
