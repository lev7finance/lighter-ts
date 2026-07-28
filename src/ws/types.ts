/**
 * Wire payload interfaces for all 22 WebSocket channels.
 *
 * Every property below is spelled **exactly** as the server spells it: snake_case, single letters,
 * and `v` next to `V`. Nothing is renamed to camelCase and no unit is normalised, because a model
 * that renames wire keys can no longer be checked against a captured frame — which is the only
 * check that can ever prove it right. Readable projections belong at the edge, above this file.
 *
 * ## Evidence status — read before trusting any shape here
 *
 * `test/fixtures/ws/capture.json` contains **zero frames**. The wave-0 capture was refused at the
 * WebSocket upgrade from a restricted jurisdiction (API code 20558; `docs/protocol-notes.md` §8.3,
 * and the `captureFailed` block in that fixture). So **no shape in this file is backed by a live
 * WebSocket frame.** The sources, in descending confidence:
 *
 * 1. `test/fixtures/rest/responses.json` — real captured REST responses. Several WS structures have
 *    a REST twin (`Trade` ↔ `/recentTrades`, the candle ↔ `/candles`, `Order` ↔
 *    `/orderBookOrders`), and where they overlap the fixture wins over the spec (`docs/decisions.md`
 *    D9). Divergences found that way are recorded inline, each naming the fixture.
 * 2. `docs/spec/06-websocket.md` §6.2, marked `[REF]` — observed in the reference client or its own
 *    test fixtures. Solid.
 * 3. The same section marked `[DOC]` — published documentation, unverified, and §15 lists fifteen
 *    open questions precisely because it is incomplete and in places wrong.
 *
 * ## Presence rule — why almost everything is optional
 *
 * `type`, `channel` and the family's payload container are required: a frame without them is not
 * that frame. **Everything else is optional.** This SDK performs no runtime schema validation
 * (`docs/ARCHITECTURE.md` §2 — the only available schema is known-wrong and would reject valid live
 * responses), so a required leaf would be an assertion the evidence cannot support, and the one
 * capture that could support it was refused. A field the server always sends still reads as
 * `T | undefined` here; that is the honest type for an unvalidated shape-cast, and it costs one
 * `?.` at the call site instead of a `TypeError` in production.
 *
 * The one place a leaf is deliberately optional for a *protocol* reason rather than an evidentiary
 * one is `OrderBookPayload.begin_nonce`: a snapshot has no predecessor to be applied on top of, and
 * `src/ws/protocol.ts` uses its absence to reclassify a mislabelled `update/order_book`.
 *
 * ## Numeric domains
 *
 * - **Money and sizes are decimal strings and stay strings.** `parseFloat`/`Number` on any of them
 *   is a defect (`docs/decisions.md` D7): `2064.54` is not exactly representable in binary64, and
 *   `"2064.50"` must compare equal to `"2064.5"`. Convert with `src/util/decimal.ts` when arithmetic
 *   is needed.
 * - **{@link WireInt} marks a JSON integer that `parseFrameJson` may have handed back as a string**
 *   because it exceeded 15 digits. Read it with {@link wireInt}.
 * - **A handful of fields genuinely arrive as JSON floats.** They are typed `number` because that is
 *   what the server sends; each carries a warning. Converting them to strings would fabricate
 *   precision that was already lost before the frame left the exchange.
 * - **Timestamp units differ per field and are never auto-normalised** (`docs/spec/06-websocket.md`
 *   §3.4). Each is documented in place: top-level `timestamp` is milliseconds; `last_updated_at` and
 *   `transaction_time` are **microseconds**; notification `created_at`/`updated_at` are RFC 3339
 *   strings.
 *
 * ## Divergences between captured fixtures and `spec/06-websocket.md`
 *
 * - **`Trade` carries four fields §6.2.5 does not list.** `test/fixtures/rest/responses.json`, case
 *   `recentTrades`, ships `taker_allocated_margin_usdc_before` and
 *   `taker_allocated_margin_usdc_after` on every trade, plus `integrator_taker_fee` and
 *   `integrator_taker_fee_collector_index` on integrator-routed ones. All four are modelled below.
 * - **`Trade.taker_fee` is not always present.** The same fixture carries `maker_fee` on trades that
 *   have no `taker_fee`, while §6.2.5 lists the two together as if both were unconditional.
 * - **The candle's OHLCV values are JSON numbers, confirmed.** The `candles` case of the same
 *   fixture returns `o: 105622.8`, `v: 602.98999`, `V: 63632159.996563` — floats on the wire,
 *   matching §6.2.6. Its REST twin (`src/models/order.ts`) additionally records `C`/`H`/`L`/`O`
 *   (secondary index OHLC, absent when zero); they are modelled here as optional, since the WS
 *   candle is the same server-side structure and §6.2.6 simply does not mention them.
 * - **`Order` as delivered by `/orderBookOrders` is a strict subset** of §6.2.11's field list
 *   (eight keys, not thirty). That is a different endpoint and so does not contradict the WS shape,
 *   but it means §6.2.11 must be read as an upper bound, which is a second reason every leaf here is
 *   optional.
 *
 * Side-effect-free at import: no I/O, no timers, no globals mutated, no `node:` import.
 */

import { parseFrameJson } from "../util/json.js";
import { LighterValidationError } from "../errors.js";

/* -------------------------------------------------------------------------------------------- */
/* Numeric domains                                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * A JSON integer that `parseFrameJson` may have rewritten to a **string** because it exceeded 15
 * digits.
 *
 * `JSON.parse` produces IEEE-754 doubles, so an integer above 2^53 is silently rounded to a nearby
 * value with nothing reporting a problem. `parseFrameJson` repairs that on the raw text — a reviver
 * cannot, the digits are gone by then — by quoting wide integers, so the value that reaches these
 * models is a `number` when it was short enough and a `string` when it was not. Both spellings are
 * therefore part of the wire contract as this SDK sees it. Read one with {@link wireInt}.
 *
 * The fields typed this way are exactly the ones `DEFAULT_BIGINT_FIELDS` covers (`src/util/json.ts`):
 * `nonce`, `begin_nonce`, `offset`, `transaction_time`, `last_updated_at`, `trade_id`, `ask_id`,
 * `bid_id`, `ask_client_id`, `bid_client_id`, `order_index`, `client_order_index`.
 */
export type WireInt = number | string;

/**
 * A {@link WireInt} as an exact `bigint`.
 *
 * Accepts the JSON number form, the quoted form `parseFrameJson` produces for 16+ digit integers,
 * and a `bigint` (harmless, and it makes the function idempotent). A 19-digit id round-trips
 * losslessly through the string form; that is the whole point of the type existing.
 *
 * @throws {LighterValidationError} `WS_WIRE_INT_INVALID` for a non-integer, a non-numeric string, or
 * a `number` outside the safe-integer range. The last case is not pedantry: a `number` that large
 * can only have reached here through a plain `JSON.parse`, which means the digits were already lost
 * upstream and the value is wrong. Failing loudly names the bug; converting silently ships it.
 *
 * Never called by {@link ChannelSpec} parsing, which must not throw — this is an explicit accessor
 * the caller reaches for when it wants the integer.
 */
export function wireInt(v: WireInt): bigint {
  const value: unknown = v;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new LighterValidationError(
        "WS_WIRE_INT_INVALID",
        `wire integer is not a safe integer: ${String(value)} (parsed without parseFrameJson?)`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) {
    return BigInt(value);
  }
  throw new LighterValidationError(
    "WS_WIRE_INT_INVALID",
    `not a wire integer: ${typeof value === "string" ? JSON.stringify(value) : String(value)}`,
  );
}

/**
 * Candle bucket widths, identical for `candle` and `mark_price_candle`
 * (`docs/spec/06-websocket.md` §6.1, `[DOC]`).
 *
 * Deliberately **not** shared with the REST `/candles` resolution set, which also accepts `1w`,
 * while `/pnl` accepts a different set again (`src/models/order.ts`). One union covering all three
 * would let a caller subscribe to a resolution this transport does not have.
 */
export type CandleResolution = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "12h" | "1d";

/* -------------------------------------------------------------------------------------------- */
/* Envelope                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * The two fields every channel frame carries.
 *
 * `type` is `subscribed/<family>` or `update/<family>`; `channel` echoes the key in the **colon**
 * spelling for most channels, the slash spelling for `account_market`, and with the account index
 * missing entirely for `account_orders` (`docs/spec/06-websocket.md` §2.3). Normalising and routing
 * it is `src/ws/protocol.ts`'s job; these models keep it verbatim.
 */
export interface WsChannelEnvelope {
  /** `"subscribed/order_book"`, `"update/trade"`, … */
  readonly type: string;
  /** `"order_book:0"`, `"candle:0:1m"`, `"account_market/3/1234"`, `"height"`, `"rfq"`. */
  readonly channel: string;
}

/* -------------------------------------------------------------------------------------------- */
/* Shared structures                                                                              */
/* -------------------------------------------------------------------------------------------- */

/** One price level, or one side of a BBO quote. Both values are decimal strings. */
export interface OrderBookLevel {
  /** Decimal string. Never parse with `parseFloat`; compare via `src/util/decimal.ts`. */
  readonly price?: string;
  /**
   * Decimal string. In an `update/order_book` a numerically-zero size is a **tombstone** meaning
   * "remove this price" — and `"0"`, `"0.0"` and `"0.0000"` all appear, so the zero test must be
   * exact rather than textual.
   */
  readonly size?: string;
}

/**
 * One executed trade.
 *
 * Confirmed against `test/fixtures/rest/responses.json`, case `recentTrades`, which is the REST twin
 * of this structure. See the divergences in this file's header: the fixture carries two allocated-
 * margin fields §6.2.5 omits, and ships `maker_fee` without `taker_fee`.
 *
 * Direction is derived from `is_maker_ask`: `false` means the **taker** was the seller.
 */
export interface Trade {
  /** @deprecated lossy — use {@link trade_id_str}, the canonical identity. */
  readonly trade_id?: WireInt;
  /** Canonical trade identity. */
  readonly trade_id_str?: string;
  readonly tx_hash?: string;
  /** Always `"trade"` in the observed fixture. */
  readonly type?: string;
  readonly market_id?: number;
  /** Base size, decimal string. */
  readonly size?: string;
  /** Decimal string. */
  readonly price?: string;
  /** Notional, decimal string. */
  readonly usd_amount?: string;
  /** @deprecated lossy — use {@link ask_id_str}. */
  readonly ask_id?: WireInt;
  readonly ask_id_str?: string;
  /** @deprecated lossy — use {@link bid_id_str}. */
  readonly bid_id?: WireInt;
  readonly bid_id_str?: string;
  /** @deprecated lossy — use {@link ask_client_id_str}. */
  readonly ask_client_id?: WireInt;
  readonly ask_client_id_str?: string;
  /** @deprecated lossy — use {@link bid_client_id_str}. */
  readonly bid_client_id?: WireInt;
  readonly bid_client_id_str?: string;
  readonly ask_account_id?: number;
  readonly bid_account_id?: number;
  /** `false` means the taker was the seller. There is no separate side field. */
  readonly is_maker_ask?: boolean;
  readonly block_height?: number;
  /** Epoch **milliseconds**. */
  readonly timestamp?: number;
  /** Epoch **microseconds**. Not milliseconds — 1000× apart, and both look plausible. */
  readonly transaction_time?: WireInt;
  readonly taker_position_size_before?: string;
  readonly taker_entry_quote_before?: string;
  /** Integer basis-point-like margin fraction, not a decimal string. */
  readonly taker_initial_margin_fraction_before?: number;
  readonly maker_position_size_before?: string;
  readonly maker_entry_quote_before?: string;
  readonly maker_initial_margin_fraction_before?: number;
  /** Integer fee in the quote asset's smallest unit. Absent on trades that charged none. */
  readonly taker_fee?: number;
  /** Integer fee in the quote asset's smallest unit. */
  readonly maker_fee?: number;
  /**
   * Allocated margin, micro-USDC, before the fill.
   *
   * Not listed in `docs/spec/06-websocket.md` §6.2.5 — found on every trade in
   * `test/fixtures/rest/responses.json`, case `recentTrades`.
   */
  readonly taker_allocated_margin_usdc_before?: number;
  /** Allocated margin, micro-USDC, after the fill. Same provenance as the field above. */
  readonly taker_allocated_margin_usdc_after?: number;
  /**
   * Integer integrator fee on the taker side. Present only on trades routed by an integrator.
   *
   * Another field §6.2.5 does not list, found in `test/fixtures/rest/responses.json`, case
   * `recentTrades`. Note the type: an **integer** here, while `Order.integrator_taker_fee` is a
   * decimal string. The same name means two different things one level apart.
   */
  readonly integrator_taker_fee?: number;
  /** The integrator's account index. Same provenance; integer. */
  readonly integrator_taker_fee_collector_index?: number;
}

/**
 * One order, as the account channels deliver it.
 *
 * `docs/spec/06-websocket.md` §6.2.11 `[DOC]`. Its REST cousin `/orderBookOrders`
 * (`test/fixtures/rest/responses.json`) ships only eight of these keys, so treat the list as an
 * upper bound rather than a guarantee.
 */
export interface Order {
  /** @deprecated lossy — use {@link order_id}, the canonical identity. */
  readonly order_index?: WireInt;
  /** @deprecated lossy — use {@link client_order_id}. */
  readonly client_order_index?: WireInt;
  /** Canonical order identity, as a string. */
  readonly order_id?: string;
  /** Canonical client-supplied identity, as a string. */
  readonly client_order_id?: string;
  readonly market_index?: number;
  readonly owner_account_index?: number;
  /** Decimal string. */
  readonly initial_base_amount?: string;
  /** Decimal string. */
  readonly price?: string;
  readonly nonce?: WireInt;
  /** Decimal string. */
  readonly remaining_base_amount?: string;
  readonly is_ask?: boolean;
  /** Raw integer ticks, already scaled by the market's `supported_size_decimals`. */
  readonly base_size?: number;
  /** Raw integer ticks, already scaled by the market's `supported_price_decimals`. */
  readonly base_price?: number;
  /** Decimal string. */
  readonly filled_base_amount?: string;
  /** Decimal string. */
  readonly filled_quote_amount?: string;
  /** `"buy"` | `"sell"`; open union because the server owns the vocabulary. */
  readonly side?: string;
  /** `"limit"`, … */
  readonly type?: string;
  /** `"good-till-time"`, … */
  readonly time_in_force?: string;
  readonly reduce_only?: boolean;
  /** Decimal string. */
  readonly trigger_price?: string;
  /** Epoch **milliseconds**. */
  readonly order_expiry?: number;
  /** `"open"`, `"filled"`, `"canceled"`, … Open union. */
  readonly status?: string;
  /** `"na"`, … Open union. */
  readonly trigger_status?: string;
  readonly trigger_time?: number;
  /** @deprecated lossy — use {@link parent_order_id}. */
  readonly parent_order_index?: WireInt;
  readonly parent_order_id?: string;
  readonly to_trigger_order_id_0?: string;
  readonly to_trigger_order_id_1?: string;
  readonly to_cancel_order_id_0?: string;
  readonly integrator_fee_collector_index?: string;
  readonly integrator_taker_fee?: string;
  readonly integrator_maker_fee?: string;
  readonly block_height?: number;
  /** Unit not pinned by the documentation; do not assume milliseconds. */
  readonly timestamp?: number;
  /** Epoch **milliseconds**. */
  readonly created_at?: number;
  /** Epoch **milliseconds**. */
  readonly updated_at?: number;
  /** Epoch **microseconds**. */
  readonly transaction_time?: WireInt;
}

/**
 * One position in one market.
 *
 * **The size is unsigned and the direction lives in a separate field.** `position` is a magnitude;
 * `sign` is `+1` for long and `−1` for short. Multiply on read. Treating `position` as signed
 * reports every short as a long, silently, and the number looks entirely reasonable.
 */
export interface Position {
  readonly market_id?: number;
  readonly symbol?: string;
  /** Decimal string. */
  readonly initial_margin_fraction?: string;
  readonly open_order_count?: number;
  readonly pending_order_count?: number;
  readonly position_tied_order_count?: number;
  /** `+1` long, `−1` short. The sign of {@link position}, which is itself unsigned. */
  readonly sign?: number;
  /** **Unsigned** magnitude, decimal string. Combine with {@link sign}. */
  readonly position?: string;
  /** Decimal string. */
  readonly avg_entry_price?: string;
  /** Decimal string. */
  readonly position_value?: string;
  /** Decimal string, may be negative. */
  readonly unrealized_pnl?: string;
  /** Decimal string, may be negative. */
  readonly realized_pnl?: string;
  /** Decimal string. */
  readonly liquidation_price?: string;
  /** Decimal string. */
  readonly total_funding_paid_out?: string;
  /** `0` cross, `1` isolated. */
  readonly margin_mode?: number;
  /** Decimal string. */
  readonly allocated_margin?: string;
}

/**
 * One asset balance.
 *
 * Available balance is `balance − locked_balance`, computed on scaled `bigint`s and never on
 * floats: `"1"` and `"1.0000"` are the same balance and both appear in real payloads
 * (`docs/spec/06-websocket.md` §3.1). {@link AccountAssetsState} does this correctly.
 *
 * Known asset ids `[REF]`: 1 ETH, 2 LIT, 3 USDC, 5 LINK, 6 UNI, 7 AAVE, 8 SKY, 9 LDO.
 */
export interface AccountAsset {
  readonly symbol?: string;
  readonly asset_id?: number;
  /** Total balance, decimal string. */
  readonly balance?: string;
  /** Portion reserved by open orders or pending withdrawals, decimal string. */
  readonly locked_balance?: string;
}

/** One realised funding payment. */
export interface PositionFunding {
  /**
   * Epoch, **unit ambiguous**: documented examples show both seconds (`1700000000`) and
   * milliseconds (`1773850000000`) — `docs/spec/06-websocket.md` §15 item 13, unresolved. Do not
   * auto-normalise; branch on magnitude at the call site if you must.
   */
  readonly timestamp?: number;
  readonly market_id?: number;
  readonly funding_id?: number;
  /** Signed decimal string: positive is received, negative is paid. */
  readonly change?: string;
  /** Decimal string. */
  readonly rate?: string;
  /** Decimal string. */
  readonly position_size?: string;
  /** `"long"` | `"short"`. Open union. */
  readonly position_side?: string;
  /** Decimal string. Absent when no discount applied. */
  readonly discount?: string;
}

/** A holding in a public pool. */
export interface PoolShare {
  readonly public_pool_index?: number;
  /** Integer share count, not a decimal string. */
  readonly shares_amount?: number;
  /** Decimal string. */
  readonly entry_usdc?: string;
  /** Decimal string. */
  readonly principal_amount?: string;
  readonly entry_timestamp?: number;
}

/* -------------------------------------------------------------------------------------------- */
/* 1. order_book                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * The nested `order_book` object. Snapshot and delta share this shape.
 *
 * In a **snapshot** `asks`/`bids` are the complete book for that side. In a **delta** they carry
 * only the changed levels, and a numerically-zero size is a tombstone. Levels are not guaranteed
 * sorted (`docs/spec/06-websocket.md` §6.2.1, `[REF]`).
 */
export interface OrderBookPayload {
  /** `0` on success. A nested status, not an envelope error — `src/ws/protocol.ts` ignores it. */
  readonly code?: number;
  readonly asks?: readonly OrderBookLevel[];
  readonly bids?: readonly OrderBookLevel[];
  readonly offset?: WireInt;
  /** Sequence number **after** this message has been applied. */
  readonly nonce?: WireInt;
  /**
   * Sequence number this message expects to be applied **on top of**.
   *
   * Optional for a protocol reason rather than an evidentiary one: a snapshot has no predecessor,
   * and `src/ws/protocol.ts` reads the absence of this key to reclassify an `update/order_book`
   * that is really a snapshot (`docs/spec/06-websocket.md` §5.3 — the published example is
   * mislabelled).
   */
  readonly begin_nonce?: WireInt;
  /** Epoch **microseconds**. */
  readonly last_updated_at?: WireInt;
}

/** `order_book/{M}` — the only channel with true delta semantics. */
export interface OrderBookMessage extends WsChannelEnvelope {
  /** Duplicated from {@link OrderBookPayload.offset}. */
  readonly offset?: WireInt;
  /** Duplicated from {@link OrderBookPayload.last_updated_at}. Epoch **microseconds**. */
  readonly last_updated_at?: WireInt;
  /** Epoch **milliseconds**. */
  readonly timestamp?: number;
  readonly order_book: OrderBookPayload;
}

/* -------------------------------------------------------------------------------------------- */
/* 2. ticker                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** The nested `ticker` object: symbol plus best ask (`a`) and best bid (`b`). */
export interface TickerPayload {
  /** Symbol. One letter on the wire. */
  readonly s?: string;
  /** Best **ask**. */
  readonly a?: OrderBookLevel;
  /** Best **bid**. */
  readonly b?: OrderBookLevel;
  /** Epoch **microseconds**. */
  readonly last_updated_at?: WireInt;
}

/** `ticker/{M}` — best bid and offer. Complete replacement each time; no delta semantics. */
export interface TickerMessage extends WsChannelEnvelope {
  /** Epoch **microseconds**. */
  readonly last_updated_at?: WireInt;
  readonly nonce?: WireInt;
  /** Epoch **milliseconds**. */
  readonly timestamp?: number;
  readonly ticker: TickerPayload;
}

/* -------------------------------------------------------------------------------------------- */
/* 3. market_stats                                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * Perp market statistics.
 *
 * Note the deliberate type split, which is a wire fact and not our confusion: prices are decimal
 * **strings**, and the five daily aggregates are JSON **floats**.
 */
export interface MarketStats {
  readonly symbol?: string;
  readonly market_id?: number;
  /** Decimal string. */
  readonly index_price?: string;
  /** Decimal string. */
  readonly mark_price?: string;
  /** Decimal string. */
  readonly mid_price?: string;
  /** Decimal string. */
  readonly best_ask_price?: string;
  /** Decimal string. */
  readonly best_bid_price?: string;
  /** Decimal string. */
  readonly open_interest?: string;
  /** Decimal string. */
  readonly open_interest_limit?: string;
  /** Decimal string. */
  readonly funding_clamp_small?: string;
  /** Decimal string. */
  readonly funding_clamp_big?: string;
  /** Decimal string. */
  readonly last_trade_price?: string;
  /** Decimal string. */
  readonly current_funding_rate?: string;
  /** Decimal string. */
  readonly funding_rate?: string;
  /** Epoch **milliseconds**. */
  readonly funding_timestamp?: number;
  /** ⚠ JSON float — a display statistic. **Never feed order math.** */
  readonly daily_base_token_volume?: number;
  /** ⚠ JSON float — a display statistic. **Never feed order math.** */
  readonly daily_quote_token_volume?: number;
  /** ⚠ JSON float — a display statistic. **Never feed order math.** */
  readonly daily_price_low?: number;
  /** ⚠ JSON float — a display statistic. **Never feed order math.** */
  readonly daily_price_high?: number;
  /** ⚠ JSON float — a display statistic. **Never feed order math.** */
  readonly daily_price_change?: number;
  /** Decimal string. */
  readonly base_interest_rate?: string;
}

/**
 * `market_stats/{M}` or `market_stats/all`.
 *
 * Under the `all` wildcard, whether the server emits one frame per market (each echoing its own
 * `market_stats:{M}` channel) or a single map is **undocumented** — `docs/spec/06-websocket.md`
 * §6.2.3 and §15 item 6. The per-market shape is modelled here; fanning out the other spelling, if
 * it turns out to exist, is the client's job and not a change to this interface.
 */
export interface MarketStatsMessage extends WsChannelEnvelope {
  /** Epoch **milliseconds**. */
  readonly timestamp?: number;
  readonly market_stats: MarketStats;
}

/* -------------------------------------------------------------------------------------------- */
/* 4. spot_market_stats                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * Spot market statistics. No mark price, no funding, no open interest — spot markets have none.
 *
 * **Spot market indices start at 2048**; perps are low indices. Any helper that assumes a small
 * market index is wrong here (`docs/spec/06-websocket.md` §6, `[REF]`).
 */
export interface SpotMarketStats {
  /** Pair symbol, e.g. `"ETH/USDC"`. */
  readonly symbol?: string;
  readonly market_id?: number;
  /** Decimal string. */
  readonly index_price?: string;
  /** Decimal string. */
  readonly mid_price?: string;
  /** Decimal string. */
  readonly last_trade_price?: string;
  /** ⚠ JSON float — display only. */
  readonly daily_base_token_volume?: number;
  /** ⚠ JSON float — display only. */
  readonly daily_quote_token_volume?: number;
  /** ⚠ JSON float — display only. */
  readonly daily_price_low?: number;
  /** ⚠ JSON float — display only. */
  readonly daily_price_high?: number;
  /** ⚠ JSON float — display only. */
  readonly daily_price_change?: number;
}

/** `spot_market_stats/{M}` or `spot_market_stats/all`. */
export interface SpotMarketStatsMessage extends WsChannelEnvelope {
  /** Epoch **milliseconds**. */
  readonly timestamp?: number;
  readonly spot_market_stats: SpotMarketStats;
}

/* -------------------------------------------------------------------------------------------- */
/* 5. trade                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * `trade/{M}` — append-only executions.
 *
 * `liquidation_trades` is a **separate array**, not a flag on {@link Trade}. A consumer that reads
 * only `trades` silently misses every liquidation.
 */
export interface TradeMessage extends WsChannelEnvelope {
  /** A book nonce, not a trade counter (`[INFER]`). */
  readonly nonce?: WireInt;
  readonly trades?: readonly Trade[];
  /** Liquidation fills. Same shape, different array. */
  readonly liquidation_trades?: readonly Trade[];
}

/* -------------------------------------------------------------------------------------------- */
/* 6–7. candle / mark_price_candle                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * One OHLCV bucket.
 *
 * **`v` and `V` differ only by case**: lowercase `v` is base volume, uppercase `V` is quote volume.
 * Any case-insensitive key handling — a helper that lowercases keys, a case-folding lookup — swaps
 * two numbers that are five orders of magnitude apart, with no symptom.
 *
 * Every OHLCV value is a JSON number. That is confirmed by real capture, not merely documented:
 * `test/fixtures/rest/responses.json`, case `candles`, returns `o: 105622.8`, `v: 602.98999`,
 * `V: 63632159.996563`. It is the one place this API does not use decimal strings for prices; treat
 * them as float-derived statistics — chart them, do not settle them.
 */
export interface Candle {
  /** Bucket start, epoch **milliseconds**. */
  readonly t?: number;
  /** ⚠ JSON float. Open. Not for money arithmetic. */
  readonly o?: number;
  /** ⚠ JSON float. High. Not for money arithmetic. */
  readonly h?: number;
  /** ⚠ JSON float. Low. Not for money arithmetic. */
  readonly l?: number;
  /** ⚠ JSON float. Close. Not for money arithmetic. */
  readonly c?: number;
  /** ⚠ JSON float. **Base** volume — lowercase. Not for money arithmetic. */
  readonly v?: number;
  /** ⚠ JSON float. **Quote** volume — uppercase. Not for money arithmetic. */
  readonly V?: number;
  /** Incrementing per-market index; a gap means a missed candle update (`[INFER]`). */
  readonly i?: number;
  /** ⚠ JSON float. Secondary (index) close. Absent when zero — REST twin, `src/models/order.ts`. */
  readonly C?: number;
  /** ⚠ JSON float. Secondary (index) high. Absent when zero. */
  readonly H?: number;
  /** ⚠ JSON float. Secondary (index) low. Absent when zero. */
  readonly L?: number;
  /** ⚠ JSON float. Secondary (index) open. Absent when zero. */
  readonly O?: number;
}

/**
 * `candle/{M}/{R}`.
 *
 * Upsert semantics: a candle in an `update/` **replaces** the bucket with the same `t`, and the
 * newest bucket is re-sent repeatedly as it forms (`[INFER]`, §6.2.6).
 */
export interface CandleMessage extends WsChannelEnvelope {
  /** Epoch **milliseconds**. */
  readonly timestamp?: number;
  readonly candles?: readonly Candle[];
}

/** One mark-price bucket: OHLC plus a sample count, and no volume at all. */
export interface MarkPriceCandle {
  /** Bucket start, epoch **milliseconds**. */
  readonly t?: number;
  /** ⚠ JSON float. Open. */
  readonly o?: number;
  /** ⚠ JSON float. High. */
  readonly h?: number;
  /** ⚠ JSON float. Low. */
  readonly l?: number;
  /** ⚠ JSON float. Close. */
  readonly c?: number;
  /** Sample count. Replaces `v`/`V`/`i` — a mark price has no traded volume. */
  readonly sc?: number;
}

/** `mark_price_candle/{M}/{R}`. */
export interface MarkPriceCandleMessage extends WsChannelEnvelope {
  /** Epoch **milliseconds**. */
  readonly timestamp?: number;
  readonly candles?: readonly MarkPriceCandle[];
}

/* -------------------------------------------------------------------------------------------- */
/* 8. height                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * `height` — block height. No index in the key, no index in the echo.
 *
 * The unit of `timestamp` here is **not pinned**: documented examples show both seconds and
 * milliseconds (`docs/spec/06-websocket.md` §3.4 and §15 item 13). Left raw on purpose.
 */
export interface HeightMessage extends WsChannelEnvelope {
  readonly height?: number;
  /** Epoch, unit ambiguous — seconds in some documented examples, milliseconds in others. */
  readonly timestamp?: number;
}

/* -------------------------------------------------------------------------------------------- */
/* 9. account_all                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * `account_all/{A}` — the fattest channel.
 *
 * **Collection shapes are inconsistent across channels on purpose**, and this interface is the
 * reference point for the differences: here `shares` is a single object and `positions` maps one
 * object per market, whereas `account_all_positions` sends `shares` as an **array** and `pool_data`
 * maps an **array** of positions per market. Each is modelled as delivered; normalising them would
 * make the model unverifiable against a frame.
 *
 * Whether an `update/` carries only the sub-objects that changed is `docs/spec/06-websocket.md` §15
 * item 2 — still open, and the reference client's wholesale replacement (defect 8) is the wrong
 * answer if updates are partial.
 */
export interface AccountAllMessage extends WsChannelEnvelope {
  readonly account?: number;
  /** Keyed by asset id, as a decimal string. */
  readonly assets?: Readonly<Record<string, AccountAsset>>;
  /** Keyed by market index. **One object per market**, not an array. */
  readonly positions?: Readonly<Record<string, Position>>;
  /** Keyed by market index. Plural key, unlike `account_market`'s singular `funding_history`. */
  readonly funding_histories?: Readonly<Record<string, PositionFunding>>;
  /** Keyed by market index. One trade per market. */
  readonly trades?: Readonly<Record<string, Trade>>;
  /** A single object here; an **array** in {@link AccountAllPositionsMessage}. */
  readonly shares?: PoolShare;
  readonly daily_trades_count?: number;
  /** ⚠ Numeric on the wire; a display aggregate. Never feed order math. */
  readonly daily_volume?: number;
  readonly weekly_trades_count?: number;
  /** ⚠ Numeric on the wire; a display aggregate. */
  readonly weekly_volume?: number;
  readonly monthly_trades_count?: number;
  /** ⚠ Numeric on the wire; a display aggregate. */
  readonly monthly_volume?: number;
  readonly total_trades_count?: number;
  /** ⚠ Numeric on the wire; a display aggregate. */
  readonly total_volume?: number;
}

/* -------------------------------------------------------------------------------------------- */
/* 10. account_market                                                                             */
/* -------------------------------------------------------------------------------------------- */

/**
 * `account_market/{M}/{A}` — one account's state in one market.
 *
 * Two spelling warts live here, both deliberate on the server's side and both modelled as
 * delivered: the key is the **singular** `position` holding an **array**, and `funding_history` is
 * singular holding a **single object**, where every other channel uses the plural `funding_histories`
 * holding a map. Its inbound `channel` also echoes **slashes** rather than colons.
 */
export interface AccountMarketMessage extends WsChannelEnvelope {
  readonly account?: number;
  /** An **array** here; a map keyed by asset id in `account_all`. */
  readonly assets?: readonly AccountAsset[];
  readonly orders?: readonly Order[];
  /** Singular key, **array** value. Not a typo. */
  readonly position?: readonly Position[];
  readonly trades?: readonly Trade[];
  /** Singular key, **single object** value. */
  readonly funding_history?: PositionFunding;
}

/* -------------------------------------------------------------------------------------------- */
/* 11. user_stats                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/** The six margin figures, repeated verbatim under `cross_stats` and `total_stats`. */
export interface UserStatsFigures {
  /** Decimal string. */
  readonly collateral?: string;
  /** Decimal string. */
  readonly portfolio_value?: string;
  /** Decimal string. */
  readonly leverage?: string;
  /** Decimal string. */
  readonly available_balance?: string;
  /** Decimal string. */
  readonly margin_usage?: string;
  /** Decimal string. */
  readonly buying_power?: string;
}

/** The nested `stats` object: the six figures at top level, plus a cross and a total breakdown. */
export interface UserStats extends UserStatsFigures {
  readonly account_trading_mode?: number;
  readonly cross_stats?: UserStatsFigures;
  readonly total_stats?: UserStatsFigures;
}

/** `user_stats/{A}` — account-level margin and portfolio figures. */
export interface UserStatsMessage extends WsChannelEnvelope {
  /** Epoch **milliseconds**. */
  readonly timestamp?: number;
  readonly stats: UserStats;
}

/* -------------------------------------------------------------------------------------------- */
/* 12. account_tx                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * One transaction as the account-tx channel delivers it.
 *
 * **`info` and `event_info` are strings containing JSON**, not objects. They are typed `string` here
 * because that is what arrives on the wire; decoding is a separate, explicit step —
 * {@link decodeAccountTxInfo} and {@link decodeAccountTxEventInfo}. The inner documents use a
 * different naming convention from the envelope around them: `info` is PascalCase
 * (`AccountIndex`, `Nonce`, `Sig`), `event_info` uses one- and two-letter keys (`a`, `i`, `u`, `ae`).
 */
export interface AccountTx {
  readonly hash?: string;
  /** Transaction type constant (`src/tx/enums.ts`). */
  readonly type?: number;
  /** **JSON-encoded string**, not an object. Decode with {@link decodeAccountTxInfo}. */
  readonly info?: string;
  /** **JSON-encoded string**, not an object. Decode with {@link decodeAccountTxEventInfo}. */
  readonly event_info?: string;
  /** `0` failed, `1` pending, `2` executed, `3` pending-final. */
  readonly status?: number;
  readonly transaction_index?: number;
  readonly l1_address?: string;
  readonly account_index?: number;
  readonly nonce?: WireInt;
  /** Epoch **milliseconds**. */
  readonly expire_at?: number;
  readonly block_height?: number;
  /** Epoch **milliseconds**. */
  readonly queued_at?: number;
  /** Epoch **milliseconds**. */
  readonly executed_at?: number;
  readonly sequence_index?: number;
  readonly parent_hash?: string;
  readonly api_key_index?: number;
  /** Epoch **microseconds**. */
  readonly transaction_time?: WireInt;
}

/**
 * `account_tx/{A}` — how a client observes the fate of a transaction it submitted.
 *
 * The WebSocket equivalent of `GET /api/v1/accountTxs`, and the reason a dropped `sendTx` ack is
 * recoverable (`docs/spec/06-websocket.md` §8.4).
 */
export interface AccountTxMessage extends WsChannelEnvelope {
  readonly txs?: readonly AccountTx[];
}

/**
 * The decoded inner `info` document. PascalCase, unlike everything around it.
 *
 * Open-ended on purpose: the key set differs per transaction type and this SDK does not validate.
 */
export interface AccountTxInfo {
  readonly AccountIndex?: number;
  readonly ApiKeyIndex?: number;
  readonly MarketIndex?: number;
  readonly Index?: WireInt;
  /** Epoch milliseconds, per the transaction schema. */
  readonly ExpiredAt?: WireInt;
  readonly Nonce?: WireInt;
  /** Hex signature. */
  readonly Sig?: string;
  readonly [key: string]: unknown;
}

/**
 * The decoded inner `event_info` document. One- and two-letter keys.
 *
 * Only the observed keys are named; everything else passes through the index signature. The
 * meanings are not documented anywhere, so none is asserted here.
 */
export interface AccountTxEventInfo {
  readonly a?: unknown;
  readonly i?: unknown;
  readonly u?: unknown;
  readonly ae?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Wide-integer keys inside the PascalCase `info` document.
 *
 * `DEFAULT_BIGINT_FIELDS` covers the snake_case envelope only, so the inner document needs its own
 * set or `Nonce` and `Index` come back through a double. Frozen module-level data, not a side
 * effect.
 */
const TX_INFO_BIGINT_FIELDS: ReadonlySet<string> = new Set<string>([
  "Nonce",
  "Index",
  "ExpiredAt",
  "AccountIndex",
  "OrderIndex",
  "ClientOrderIndex",
]);

/**
 * Decode the JSON-in-a-string `info` field. Total: returns `undefined` rather than throwing.
 *
 * Never throws, for the same reason `decodeFrame` never throws — this sits on a read loop, and one
 * malformed inner document must not take a subscription down. Goes through `parseFrameJson` so a
 * 64-bit `Nonce` or `Index` survives as a string instead of being rounded by `JSON.parse`.
 */
export function decodeAccountTxInfo(raw: string | undefined): AccountTxInfo | undefined {
  return decodeEmbeddedJson(raw, TX_INFO_BIGINT_FIELDS) as AccountTxInfo | undefined;
}

/** Decode the JSON-in-a-string `event_info` field. Total, like its sibling above. */
export function decodeAccountTxEventInfo(
  raw: string | undefined,
): AccountTxEventInfo | undefined {
  return decodeEmbeddedJson(raw, TX_INFO_BIGINT_FIELDS) as AccountTxEventInfo | undefined;
}

/** Shared body of the two decoders: parse, accept only a plain object, swallow everything else. */
function decodeEmbeddedJson(
  raw: string | undefined,
  fields: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = parseFrameJson(raw, fields);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/* -------------------------------------------------------------------------------------------- */
/* 13–14. account_all_orders / account_orders                                                     */
/* -------------------------------------------------------------------------------------------- */

/** `account_all_orders/{A}` — every open order, keyed by market index. */
export interface AccountAllOrdersMessage extends WsChannelEnvelope {
  /** Keyed by market index, **array** of orders per market. */
  readonly orders?: Readonly<Record<string, readonly Order[]>>;
}

/**
 * `account_orders/{M}/{A}` — one market's orders for one account.
 *
 * Its inbound `channel` is `account_orders:{M}` with the **account index missing entirely**; the
 * account arrives in this sibling `account` field, which is what `resolveRouteKey` in
 * `src/ws/protocol.ts` reconstructs the routing key from (`docs/spec/06-websocket.md` §2.3, and §15
 * item 15 asks for this to be confirmed on a live socket).
 */
export interface AccountOrdersMessage extends WsChannelEnvelope {
  /** The only place the account index appears on this channel. Routing depends on it. */
  readonly account?: number;
  readonly nonce?: WireInt;
  /** Keyed by market index, **array** of orders per market. */
  readonly orders?: Readonly<Record<string, readonly Order[]>>;
}

/* -------------------------------------------------------------------------------------------- */
/* 15. account_all_trades — the one genuine snapshot/update asymmetry                             */
/* -------------------------------------------------------------------------------------------- */

/**
 * `subscribed/account_all_trades` — `trades` is a **flat array**, plus four volume aggregates.
 *
 * This is why {@link ChannelSpec} carries two type parameters. The update below has a different
 * `trades` shape and none of the aggregates; collapsing the two loses one or the other.
 */
export interface AccountAllTradesSnapshot extends WsChannelEnvelope {
  /** **Flat array** in the snapshot. */
  readonly trades?: readonly Trade[];
  /** ⚠ JSON float. Snapshot only. Display aggregate — never feed order math. */
  readonly total_volume?: number;
  /** ⚠ JSON float. Snapshot only. */
  readonly monthly_volume?: number;
  /** ⚠ JSON float. Snapshot only. */
  readonly weekly_volume?: number;
  /** ⚠ JSON float. Snapshot only. */
  readonly daily_volume?: number;
}

/**
 * `update/account_all_trades` — `trades` is a **market-keyed map**, and the aggregates are gone.
 *
 * Not a variation on the snapshot: a different shape under the same key.
 */
export interface AccountAllTradesUpdate extends WsChannelEnvelope {
  /** **Map** keyed by market index in updates. */
  readonly trades?: Readonly<Record<string, readonly Trade[]>>;
}

/* -------------------------------------------------------------------------------------------- */
/* 16. account_all_positions                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** `account_all_positions/{A}`. Note `shares` is an **array** here and an object in `account_all`. */
export interface AccountAllPositionsMessage extends WsChannelEnvelope {
  /** Keyed by market index, one object per market. */
  readonly positions?: Readonly<Record<string, Position>>;
  /** An **array** here; a single object in {@link AccountAllMessage}. */
  readonly shares?: readonly PoolShare[];
  /** Keyed by market index; decimal-string values. */
  readonly last_funding_round?: Readonly<Record<string, string>>;
  /** Keyed by market index; decimal-string values. */
  readonly last_funding_discount?: Readonly<Record<string, string>>;
}

/* -------------------------------------------------------------------------------------------- */
/* 17. account_all_assets                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * `account_all_assets/{A}` — per-asset balances.
 *
 * **There is no `account` field.** The account index is recoverable only from the `channel` string
 * (`account_all_assets:{A}`), which is why {@link ChannelSpec} carries `accountIndex` and why
 * {@link AccountAssetsState} must be constructed with one rather than reading it off a payload
 * (`docs/spec/06-websocket.md` §6.2.9, `[REF]`).
 */
export interface AccountAssetsMessage extends WsChannelEnvelope {
  /** Epoch **milliseconds**. */
  readonly timestamp?: number;
  /** Keyed by asset id, as a decimal string. */
  readonly assets?: Readonly<Record<string, AccountAsset>>;
}

/* -------------------------------------------------------------------------------------------- */
/* 18. account_spot_avg_entry_prices                                                              */
/* -------------------------------------------------------------------------------------------- */

/** One asset's spot cost basis. */
export interface SpotAvgEntry {
  readonly asset_id?: number;
  /** Decimal string. */
  readonly avg_entry_price?: string;
  /** Decimal string. */
  readonly asset_size?: string;
  readonly last_trade_id?: WireInt;
}

/** `account_spot_avg_entry_prices/{A}`. */
export interface SpotAvgEntryMessage extends WsChannelEnvelope {
  /** Epoch **milliseconds**. */
  readonly timestamp?: number;
  /** Keyed by asset index, as a decimal string. */
  readonly avg_entry_prices?: Readonly<Record<string, SpotAvgEntry>>;
}

/* -------------------------------------------------------------------------------------------- */
/* 19–20. pool_data / pool_info                                                                   */
/* -------------------------------------------------------------------------------------------- */

/** One point on a pool's daily-return series. */
export interface PoolDailyReturn {
  readonly timestamp?: number;
  /** ⚠ JSON float — a charting statistic. Never feed order math. */
  readonly daily_return?: number;
}

/** One point on a pool's share-price series. */
export interface PoolSharePrice {
  readonly timestamp?: number;
  /** ⚠ JSON float — a charting statistic. Never feed order math. */
  readonly share_price?: number;
}

/** One strategy slot inside a pool. */
export interface PoolStrategy {
  /** Decimal string. */
  readonly collateral?: string;
}

/** The nested `pool_info` object. */
export interface PoolInfo {
  readonly status?: number;
  /** Decimal string. */
  readonly operator_fee?: string;
  /** Decimal string. */
  readonly min_operator_share_rate?: string;
  /** Integer share count. */
  readonly total_shares?: number;
  /** Integer share count. */
  readonly operator_shares?: number;
  /** ⚠ JSON float — a charting statistic. Never feed order math. */
  readonly annual_percentage_yield?: number;
  /** ⚠ JSON float — a charting statistic. Never feed order math. */
  readonly sharpe_ratio?: number;
  readonly daily_returns?: readonly PoolDailyReturn[];
  readonly share_prices?: readonly PoolSharePrice[];
  readonly strategies?: readonly PoolStrategy[];
}

/** `pool_info/{A}` — a public pool's configuration and performance series. */
export interface PoolInfoMessage extends WsChannelEnvelope {
  readonly pool_info: PoolInfo;
}

/**
 * `pool_data/{A}` — a public pool's live trading state.
 *
 * `positions` maps an **array** per market here, unlike `account_all`, where the same key maps a
 * single object per market.
 */
export interface PoolDataMessage extends WsChannelEnvelope {
  readonly account?: number;
  /** Keyed by market index, array per market. */
  readonly trades?: Readonly<Record<string, readonly Trade[]>>;
  /** Keyed by market index, array per market. */
  readonly orders?: Readonly<Record<string, readonly Order[]>>;
  /** Keyed by market index, **array** per market — not one object as in `account_all`. */
  readonly positions?: Readonly<Record<string, readonly Position[]>>;
  /** An **array**, as in `account_all_positions`. */
  readonly shares?: readonly PoolShare[];
  /** Keyed by market index, array per market. */
  readonly funding_histories?: Readonly<Record<string, readonly PositionFunding[]>>;
}

/* -------------------------------------------------------------------------------------------- */
/* 21. notification                                                                               */
/* -------------------------------------------------------------------------------------------- */

/** Fields every notification carries, whatever its `kind`. */
export interface NotificationCommon {
  readonly id?: string;
  /** **RFC 3339 string**, not an epoch number. */
  readonly created_at?: string;
  /** **RFC 3339 string**, not an epoch number. */
  readonly updated_at?: string;
  readonly account_index?: number;
  readonly ack?: boolean;
  /** **RFC 3339 string**, or `null` when never acknowledged. */
  readonly acked_at?: string | null;
}

/** `content` of a `"liquidation"` notification. */
export interface LiquidationContent {
  readonly id?: string;
  readonly is_ask?: boolean;
  /** Decimal string. */
  readonly usdc_amount?: string;
  /** Decimal string. */
  readonly size?: string;
  readonly market_index?: number;
  /** Decimal string. */
  readonly price?: string;
  /** Epoch **seconds** in the documented example. */
  readonly timestamp?: number;
  /** Decimal string. */
  readonly avg_price?: string;
}

/** `content` of a `"deleverage"` notification. */
export interface DeleverageContent {
  readonly id?: string;
  /** Decimal string. */
  readonly usdc_amount?: string;
  /** Decimal string. */
  readonly size?: string;
  readonly market_index?: number;
  /** Decimal string. */
  readonly settlement_price?: string;
  /** Epoch **seconds** in the documented example. */
  readonly timestamp?: number;
}

/** A forced-liquidation notification. */
export interface LiquidationNotification extends NotificationCommon {
  readonly kind: "liquidation";
  readonly content?: LiquidationContent;
}

/** An auto-deleveraging notification. */
export interface DeleverageNotification extends NotificationCommon {
  readonly kind: "deleverage";
  readonly content?: DeleverageContent;
}

/**
 * The default arm: any `kind` this version does not model, carrying `content` as `unknown`.
 *
 * Its existence is the point. Only `"liquidation"` and `"deleverage"` have been observed, the
 * server owns the vocabulary, and a new kind must widen the union rather than break parsing.
 */
export interface UnknownNotification extends NotificationCommon {
  readonly kind: string;
  readonly content?: unknown;
}

/**
 * One notification, discriminated on `kind`.
 *
 * TypeScript cannot narrow a union whose default arm has `kind: string` — the open arm matches every
 * literal comparison — so narrow with {@link isLiquidationNotification} /
 * {@link isDeleverageNotification} rather than with `n.kind === "liquidation"`.
 */
export type Notification =
  | LiquidationNotification
  | DeleverageNotification
  | UnknownNotification;

/** Narrow a {@link Notification} to the liquidation arm. Total; never throws. */
export function isLiquidationNotification(n: Notification): n is LiquidationNotification {
  return n.kind === "liquidation";
}

/** Narrow a {@link Notification} to the deleverage arm. Total; never throws. */
export function isDeleverageNotification(n: Notification): n is DeleverageNotification {
  return n.kind === "deleverage";
}

/**
 * `notification/{A}`.
 *
 * Acknowledgement is **REST-only** (`POST /api/v1/notification/ack`); there is no WebSocket ack
 * frame for a notification.
 */
export interface NotificationMessage extends WsChannelEnvelope {
  readonly notifs?: readonly Notification[];
}

/* -------------------------------------------------------------------------------------------- */
/* 22. rfq                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** One request for quote. */
export interface Rfq {
  readonly id?: number;
  readonly account_index?: number;
  readonly market_index?: number;
  /** `+1` / `−1`. A direction field, not a size. */
  readonly direction?: number;
  /** Decimal string. */
  readonly base_amount?: string;
  /** Decimal string. */
  readonly quote_amount?: string;
  /** `"opened"`, … Open union; the server owns the vocabulary. */
  readonly status?: string;
  /** Free-form; the documentation asserts no shape. */
  readonly metadata?: unknown;
  /** Free-form; the documentation asserts no shape. */
  readonly responses?: readonly unknown[];
  /** Epoch **milliseconds**. */
  readonly created_at?: number;
  /** Epoch **milliseconds**. */
  readonly updated_at?: number;
}

/** `rfq` — no index in the key, no index in the echo. */
export interface RfqMessage extends WsChannelEnvelope {
  readonly rfqs?: readonly Rfq[];
}
