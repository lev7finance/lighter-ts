/**
 * Order, trade and candle models.
 *
 * The literal unions here are the most valuable types in the SDK: an exhaustive `switch` over
 * {@link OrderStatus} is exactly what a trading consumer wants, and it is what a generated client
 * cannot give you, because the generator would have emitted `string`.
 *
 * Types only. Nothing in this file runs.
 */

import type {
  Cursored,
  DecimalString,
  EpochMicros,
  EpochMs,
  Int64String,
  ResultCode,
} from "./common.js";

/* -------------------------------------------------------------------------------------------- */
/* Order literal unions                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * The terminal and non-terminal states of an order — 17 members, reproduced exactly.
 *
 * The `canceled-*` members are the whole point: they say *why*. `canceled-post-only` means the
 * order would have crossed, `canceled-too-much-slippage` means the price protection fired,
 * `canceled-oco` / `canceled-child` are the bracket state machine unwinding. Collapsing them to
 * `'canceled'` throws away the only diagnosis the exchange offers.
 */
export type OrderStatus =
  | "in-progress"
  | "pending"
  | "open"
  | "filled"
  | "canceled"
  | "canceled-post-only"
  | "canceled-reduce-only"
  | "canceled-position-not-allowed"
  | "canceled-margin-not-allowed"
  | "canceled-too-much-slippage"
  | "canceled-not-enough-liquidity"
  | "canceled-self-trade"
  | "canceled-expired"
  | "canceled-oco"
  | "canceled-child"
  | "canceled-liquidation"
  | "canceled-invalid-balance";

/** The nine order types the matching engine reports. `twap-sub` is a child slice of a `twap`. */
export type OrderType =
  | "limit"
  | "market"
  | "stop-loss"
  | "stop-loss-limit"
  | "take-profit"
  | "take-profit-limit"
  | "twap"
  | "twap-sub"
  | "liquidation";

/**
 * Time-in-force.
 *
 * `'Unknown'` is capitalised, unlike every other kebab-case member of this union. That is a wire
 * fact, not a typo to normalise — normalising it would make a real server response fail to match.
 */
export type TimeInForce = "good-till-time" | "immediate-or-cancel" | "post-only" | "Unknown";

/** Trigger state for conditional orders. `'na'` means the order is not conditional. */
export type TriggerStatus = "na" | "ready" | "mark-price" | "twap" | "parent-order";

/* -------------------------------------------------------------------------------------------- */
/* Orders                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * A full order record, from `GET /api/v1/accountActiveOrders` and
 * `GET /api/v1/accountInactiveOrders` (both authenticated).
 *
 * The `parent_order_*`, `to_trigger_order_id_*` and `to_cancel_order_id_*` fields encode the
 * OCO/OTO/bracket relationships between orders.
 */
export interface Order {
  /**
   * Lossy: `int64` domain parsed as a JSON number. Prefer {@link Order.order_id}, which carries
   * the same value as a string. Never use this in SDK-internal logic.
   */
  order_index?: number;
  /** Canonical order identity. */
  order_id?: Int64String;
  /**
   * Lossy: `int64` domain parsed as a JSON number. Prefer {@link Order.client_order_id}.
   */
  client_order_index?: number;
  /** Canonical client-order identity. */
  client_order_id?: Int64String;
  market_index?: number;
  owner_account_index?: number;
  nonce?: number;
  initial_base_amount?: DecimalString;
  remaining_base_amount?: DecimalString;
  filled_base_amount?: DecimalString;
  filled_quote_amount?: DecimalString;
  price?: DecimalString;
  trigger_price?: DecimalString;
  /** The raw scaled integer form the transaction carried: `size × 10^supported_size_decimals`. */
  base_size?: number;
  /** The raw scaled integer form the transaction carried: `price × 10^supported_price_decimals`. */
  base_price?: number;
  is_ask?: boolean;
  /**
   * Free text on the wire — the OpenAPI document declares no enum for it and no live capture in
   * `test/fixtures/rest/` contains an order. Use {@link Order.is_ask} for direction, which is
   * unambiguous.
   */
  side?: string;
  reduce_only?: boolean;
  type?: OrderType;
  time_in_force?: TimeInForce;
  status?: OrderStatus;
  trigger_status?: TriggerStatus;
  /** Epoch milliseconds. */
  trigger_time?: EpochMs;
  /** Epoch milliseconds. */
  order_expiry?: EpochMs;
  /** Lossy `int64`; prefer {@link Order.parent_order_id}. */
  parent_order_index?: number;
  parent_order_id?: Int64String;
  to_trigger_order_id_0?: Int64String;
  to_trigger_order_id_1?: Int64String;
  to_cancel_order_id_0?: Int64String;
  block_height?: number;
  /** Epoch milliseconds. */
  timestamp?: EpochMs;
  /** Epoch milliseconds. */
  created_at?: EpochMs;
  /** Epoch milliseconds. */
  updated_at?: EpochMs;
  /** Epoch **microseconds** — not milliseconds, unlike every other timestamp on this model. */
  transaction_time?: EpochMicros;
  /** A decimal string on `Order`, though the same concept is an integer tick on `Trade`. */
  integrator_fee_collector_index?: string;
  /** A decimal string on `Order`, though the same concept is an integer tick on `Trade`. */
  integrator_maker_fee?: string;
  /** A decimal string on `Order`, though the same concept is an integer tick on `Trade`. */
  integrator_taker_fee?: string;
}

export interface Orders extends ResultCode, Cursored {
  orders?: Order[];
}

/**
 * A single resting order in the book, from `GET /api/v1/orderBookOrders`.
 *
 * This endpoint returns **individual orders, not aggregated price levels**. Aggregated depth
 * (`PriceLevel { price, size }`) exists only over the WebSocket; anyone needing an aggregated book
 * from REST must fold these themselves.
 */
export interface SimpleOrder {
  /** Lossy `int64`; prefer {@link SimpleOrder.order_id}. */
  order_index?: number;
  /** Canonical order identity. */
  order_id?: Int64String;
  owner_account_index?: number;
  initial_base_amount?: DecimalString;
  remaining_base_amount?: DecimalString;
  price?: DecimalString;
  /** Epoch milliseconds. */
  order_expiry?: EpochMs;
  /** Epoch **microseconds**. Frequently `0` on this endpoint. */
  transaction_time?: EpochMicros;
}

/**
 * `GET /api/v1/orderBookOrders?market_id&limit` (limit 1..250).
 *
 * `asks` ascend by price and `bids` descend (verified live). `total_asks` and `total_bids` are the
 * counts **returned**, bounded by `limit` — they are not book totals, and using them for depth
 * statistics is wrong.
 */
export interface OrderBookOrders extends ResultCode {
  total_asks?: number;
  asks?: SimpleOrder[];
  total_bids?: number;
  bids?: SimpleOrder[];
}

/* -------------------------------------------------------------------------------------------- */
/* Trades                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** How a trade came about. `'trade'` is an ordinary match; the rest are forced. */
export type TradeType = "trade" | "liquidation" | "deleverage" | "market-settlement";

/**
 * An executed trade, from `GET /api/v1/recentTrades` (public) and `GET /api/v1/trades` (auth).
 *
 * **Everything from `taker_fee` downwards was absent from a live BTC trade** while the OpenAPI
 * document marked it `required` (`spec/05-rest-api.md` §9.2). That measurement is why this whole
 * directory is hand-authored.
 */
export interface Trade {
  /** Lossy `int64`; prefer {@link Trade.trade_id_str}. */
  trade_id?: number;
  /** Canonical trade identity. */
  trade_id_str?: Int64String;
  tx_hash?: string;
  type?: TradeType;
  market_id?: number;
  size?: DecimalString;
  price?: DecimalString;
  usd_amount?: DecimalString;
  /** Lossy `int64`; prefer {@link Trade.ask_id_str}. */
  ask_id?: number;
  /** Canonical. Marked optional by the document, present on every live trade observed. */
  ask_id_str?: Int64String;
  /** Lossy `int64`; prefer {@link Trade.bid_id_str}. */
  bid_id?: number;
  /** Canonical. Marked optional by the document, present on every live trade observed. */
  bid_id_str?: Int64String;
  /** Lossy `int64`; prefer {@link Trade.ask_client_id_str}. */
  ask_client_id?: number;
  ask_client_id_str?: Int64String;
  /** Lossy `int64`; prefer {@link Trade.bid_client_id_str}. */
  bid_client_id?: number;
  bid_client_id_str?: Int64String;
  ask_account_id?: number;
  bid_account_id?: number;
  is_maker_ask?: boolean;
  block_height?: number;
  /** Epoch milliseconds. */
  timestamp?: EpochMs;
  /** Epoch **microseconds** — three digits wider than `timestamp` on the same object. */
  transaction_time?: EpochMicros;
  taker_position_size_before?: DecimalString;
  taker_entry_quote_before?: DecimalString;
  /** Basis points. The document's `"format": "uin16"` is a typo; it is a plain integer. */
  taker_initial_margin_fraction_before?: number;
  /** Absent when false. */
  taker_position_sign_changed?: boolean;
  maker_position_size_before?: DecimalString;
  maker_entry_quote_before?: DecimalString;
  /** Basis points. */
  maker_initial_margin_fraction_before?: number;
  /** Absent when false. */
  maker_position_sign_changed?: boolean;
  /** Fee tick, not a currency amount. Absent when zero. */
  taker_fee?: number;
  /** Fee tick, not a currency amount. Absent when zero. */
  maker_fee?: number;
  ask_account_pnl?: DecimalString;
  bid_account_pnl?: DecimalString;
  /** Fee tick. Absent unless an integrator was involved. */
  integrator_maker_fee?: number;
  integrator_maker_fee_collector_index?: number;
  /** Fee tick. Absent unless an integrator was involved. */
  integrator_taker_fee?: number;
  integrator_taker_fee_collector_index?: number;
  /** Scaled USDC integer (1e6). Absent when zero. */
  taker_allocated_margin_usdc_before?: number;
  /** Scaled USDC integer (1e6). Absent when zero. */
  taker_allocated_margin_usdc_after?: number;
  /** Scaled USDC integer (1e6). Absent when zero. */
  maker_allocated_margin_usdc_before?: number;
  /** Scaled USDC integer (1e6). Absent when zero. */
  maker_allocated_margin_usdc_after?: number;
}

/** `next_cursor` was absent from a live response despite being marked `required` (§9.2). */
export interface Trades extends ResultCode, Cursored {
  trades?: Trade[];
}

/* -------------------------------------------------------------------------------------------- */
/* Candles                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * One OHLCV candle, from `GET /api/v1/candles`.
 *
 * The single-letter keys are **case-sensitive** and are kept exactly as the wire spells them:
 * lowercase `v` is base volume, uppercase `V` is quote volume, and confusing the two silently
 * changes the unit by five orders of magnitude. The readable mapping
 * (`{ time, open, high, low, close, baseVolume, quoteVolume }`) belongs at the edge, in
 * `src/rest/candles.ts` — not here, because a model that renames wire keys can no longer be
 * checked against a captured response.
 *
 * Every OHLCV value is a JSON **number**. That is the one place the API does not use decimal
 * strings for prices, and it is a wire fact rather than something to correct. Treat them as
 * float-derived statistics: chart them, do not settle them.
 */
export interface Candle {
  /** Open time, epoch **milliseconds** — or the *end* time when `set_timestamp_to_end=true`. */
  t?: EpochMs;
  /** Open. Float-derived; not for money arithmetic. */
  o?: number;
  /** High. Float-derived; not for money arithmetic. */
  h?: number;
  /** Low. Float-derived; not for money arithmetic. */
  l?: number;
  /** Close. Float-derived; not for money arithmetic. */
  c?: number;
  /** **Base** volume (lowercase `v`). Float-derived. */
  v?: number;
  /** **Quote** volume (uppercase `V`). Float-derived. */
  V?: number;
  /** Interval/index counter. */
  i?: number;
  /** Secondary (index) close. **Absent when zero** — verified absent on BTC. */
  C?: number;
  /** Secondary (index) high. Absent when zero. */
  H?: number;
  /** Secondary (index) low. Absent when zero. */
  L?: number;
  /** Secondary (index) open. Absent when zero. */
  O?: number;
}

/**
 * `GET /api/v1/candles`, at most 500 candles per call.
 *
 * Note the collision: `Candles.c` is the **array of candles**, while `Candle.c` one level down is
 * the **close price**. Both are correct; neither may be renamed.
 *
 * Resolutions differ per endpoint and must not share one union: `candles` accepts
 * `1m|5m|15m|30m|1h|4h|12h|1d|1w`, `pnl` accepts `1m|5m|15m|1h|4h|1d`, `fundings` accepts `1h|1d`.
 */
export interface Candles extends ResultCode {
  /** Echo of the requested resolution, e.g. `"1h"`. */
  r?: string;
  /** The candles. Not the close price — see the note above. */
  c?: Candle[];
}
